import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTokenCacheForTests,
  fetchToken,
  getAccessToken,
} from '../src/auth/tokenCache.js';

interface MockResponse {
  status: number;
  statusText?: string;
  body: object;
}

function makeFetchMock(responses: MockResponse[]): {
  fn: typeof fetch;
  calls: Array<{ url: string; body: string }>;
} {
  const calls: Array<{ url: string; body: string }> = [];
  let i = 0;
  const fn = ((url: string, init?: RequestInit) => {
    const response = responses[Math.min(i, responses.length - 1)];
    i++;
    calls.push({ url, body: String(init?.body ?? '') });
    return Promise.resolve({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText ?? '',
      json: async () => response.body,
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('tokenCache', () => {
  let nowMs: number;
  const advance = (ms: number) => {
    nowMs += ms;
  };

  beforeEach(() => {
    nowMs = 1_000_000_000;
  });

  it('fetchToken sends the right form body and parses access_token', async () => {
    const { fn, calls } = makeFetchMock([
      { status: 200, body: { access_token: 'abc', expires_in: 300 } },
    ]);
    __resetTokenCacheForTests({ fetch: fn, now: () => nowMs });

    const token = await fetchToken({ clientId: 'id1', clientSecret: 'sec1' });

    expect(token.accessToken).toBe('abc');
    expect(token.expiresAt).toBe(nowMs + 300_000);
    expect(calls).toHaveLength(1);
    const body = new URLSearchParams(calls[0].body);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe('id1');
    expect(body.get('client_secret')).toBe('sec1');
    expect(body.get('audience')).toBe('https://api2.arduino.cc/iot');
    expect(body.get('organization_id')).toBeNull();
  });

  it('fetchToken includes organization_id when supplied', async () => {
    const { fn, calls } = makeFetchMock([
      { status: 200, body: { access_token: 't', expires_in: 300 } },
    ]);
    __resetTokenCacheForTests({ fetch: fn, now: () => nowMs });

    await fetchToken({ clientId: 'id', clientSecret: 's', organizationId: 'org-1' });
    expect(new URLSearchParams(calls[0].body).get('organization_id')).toBe('org-1');
  });

  it('fetchToken surfaces API error messages', async () => {
    const { fn } = makeFetchMock([
      { status: 401, statusText: 'Unauthorized', body: { message: 'invalid credentials' } },
    ]);
    __resetTokenCacheForTests({ fetch: fn, now: () => nowMs });

    await expect(
      fetchToken({ clientId: 'id', clientSecret: 's' }),
    ).rejects.toThrow(/401.*invalid credentials/);
  });

  it('getAccessToken caches across calls', async () => {
    const { fn, calls } = makeFetchMock([
      { status: 200, body: { access_token: 'one', expires_in: 300 } },
    ]);
    __resetTokenCacheForTests({ fetch: fn, now: () => nowMs });

    const a = await getAccessToken({ clientId: 'id', clientSecret: 's' });
    advance(60_000);
    const b = await getAccessToken({ clientId: 'id', clientSecret: 's' });
    expect(a).toBe('one');
    expect(b).toBe('one');
    expect(calls).toHaveLength(1);
  });

  it('getAccessToken re-fetches inside the expiry safety margin', async () => {
    const { fn, calls } = makeFetchMock([
      { status: 200, body: { access_token: 'one', expires_in: 60 } },
      { status: 200, body: { access_token: 'two', expires_in: 60 } },
    ]);
    __resetTokenCacheForTests({ fetch: fn, now: () => nowMs });

    await getAccessToken({ clientId: 'id', clientSecret: 's' });
    // 60s TTL, 30s safety margin — after 31s we should refresh.
    advance(31_000);
    const next = await getAccessToken({ clientId: 'id', clientSecret: 's' });
    expect(next).toBe('two');
    expect(calls).toHaveLength(2);
  });

  it('getAccessToken coalesces concurrent callers', async () => {
    let resolveFetch!: (v: Response) => void;
    const fn = vi.fn(() =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    __resetTokenCacheForTests({
      fetch: fn as unknown as typeof fetch,
      now: () => nowMs,
    });

    const p1 = getAccessToken({ clientId: 'id', clientSecret: 's' });
    const p2 = getAccessToken({ clientId: 'id', clientSecret: 's' });

    resolveFetch({
      ok: true,
      status: 200,
      statusText: '',
      json: async () => ({ access_token: 'shared', expires_in: 300 }),
    } as unknown as Response);

    expect(await p1).toBe('shared');
    expect(await p2).toBe('shared');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('different credentials get independent cache entries', async () => {
    const { fn, calls } = makeFetchMock([
      { status: 200, body: { access_token: 'A', expires_in: 300 } },
      { status: 200, body: { access_token: 'B', expires_in: 300 } },
    ]);
    __resetTokenCacheForTests({ fetch: fn, now: () => nowMs });

    const a = await getAccessToken({ clientId: 'idA', clientSecret: 's' });
    const b = await getAccessToken({ clientId: 'idB', clientSecret: 's' });
    expect(a).toBe('A');
    expect(b).toBe('B');
    expect(calls).toHaveLength(2);
  });
});
