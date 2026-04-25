/**
 * ArduinoCloud.execute() — tests for user-visible contracts and invariants
 * that aren't visible from reading the source.
 *
 * What's worth testing here:
 *   - The JSON shape downstream nodes (and the LLM, when used as a tool) see.
 *   - The LLM-feedback contract: a guard rejection produces a string the
 *     agent can read and self-correct on; the rejection does not consume
 *     rate-limit budget; rate-limit short-circuits the guard.
 *   - The boundary type-coercion the README commits to (Location/Color
 *     objects pass through; explicit "json" surfaces a clear parse error,
 *     not an opaque 400 from the API).
 *   - GetHistory defaults — the "leave both blank → last hour" promise the
 *     LLM relies on for "is today unusual?" prompts.
 *   - n8n integration contracts: continueOnFail, parameter independence
 *     across (thingId, propertyId, operation) for the rate-limit counter.
 *
 * What's intentionally NOT here: per-branch enumeration of parseValue, the
 * exact text of validation throws, and other "the code I wrote does what I
 * wrote" tautologies (see feedback_significant_tests_only memory).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/arduinoCloudApi.js', () => ({
  listThings: vi.fn(),
  listProperties: vi.fn(),
  getProperty: vi.fn(),
  publishProperty: vi.fn(),
  historicData: vi.fn(),
}));

import { ArduinoCloud } from '../src/nodes/ArduinoCloud/ArduinoCloud.node.js';
import { __resetRateLimiterForTests } from '../src/rateLimiter.js';
import * as api from '../src/arduinoCloudApi.js';

const mockedApi = api as unknown as {
  listThings: ReturnType<typeof vi.fn>;
  listProperties: ReturnType<typeof vi.fn>;
  getProperty: ReturnType<typeof vi.fn>;
  publishProperty: ReturnType<typeof vi.fn>;
  historicData: ReturnType<typeof vi.fn>;
};

interface Params {
  resource?: string;
  operation?: 'get' | 'set' | 'getHistory';
  thingId?: string;
  propertyId?: string;
  value?: unknown;
  valueType?: 'auto' | 'string' | 'number' | 'boolean' | 'json';
  from?: string | Date | null;
  to?: string | Date | null;
  idempotent?: boolean;
  rateLimit?: { maxCalls?: number; window?: 'minute' | 'hour' | 'day' };
  propertyGuard?: string;
  options?: { timeout?: number };
}

const DEFAULTS: Required<Pick<Params, 'resource' | 'operation' | 'thingId' | 'propertyId'>> = {
  resource: 'property',
  operation: 'get',
  thingId: 'thing-1',
  propertyId: 'prop-1',
};

interface CtxOpts {
  continueOnFail?: boolean;
  nodeId?: string;
}

function makeCtx(items: unknown[], params: Params, opts: CtxOpts = {}): unknown {
  const full: Params = { ...DEFAULTS, ...params };
  return {
    getInputData: () => items.map((item) => ({ json: (item as object) ?? {} })),
    getNode: () => ({
      id: opts.nodeId ?? 'node-test',
      name: 'ArduinoCloud',
      type: 'n8n-nodes-arduino-cloud.arduinoCloud',
      typeVersion: 1,
    }),
    continueOnFail: () => opts.continueOnFail ?? false,
    getNodeParameter: (name: string, _i: number, dflt?: unknown) => {
      if (name in full) return (full as Record<string, unknown>)[name];
      if (dflt !== undefined) return dflt;
      throw new Error(`fake ctx: no param "${name}" configured and no default`);
    },
    getCredentials: async () => ({
      clientId: 'cid',
      clientSecret: 'csecret',
      organizationId: '',
    }),
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(ctx: unknown): Promise<any[]> {
  const node = new ArduinoCloud();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await (node.execute as any).call(ctx);
  return out[0];
}

const STD_PROP = {
  id: 'prop-1',
  name: 'Temperature',
  variable_name: 'temperature',
  type: 'FLOAT',
  permission: 'READ_WRITE',
  last_value: 21.5,
  value_updated_at: '2026-04-25T12:00:00.000Z',
};

describe('ArduinoCloud — output shape', () => {
  beforeEach(() => {
    __resetRateLimiterForTests();
    mockedApi.getProperty.mockReset();
    mockedApi.publishProperty.mockReset();
    mockedApi.historicData.mockReset();
  });

  it('Get returns the property snapshot the next node / LLM will read', async () => {
    mockedApi.getProperty.mockResolvedValue(STD_PROP);

    const out = await run(makeCtx([{}], { operation: 'get' }));

    // Flat fields, last_value at top level (not nested under .property),
    // ISO timestamp string for value_updated_at — the LLM-friendly shape.
    expect(out[0].json).toEqual({
      operation: 'get',
      thingId: 'thing-1',
      propertyId: 'prop-1',
      name: 'Temperature',
      variable_name: 'temperature',
      type: 'FLOAT',
      permission: 'READ_WRITE',
      last_value: 21.5,
      value_updated_at: '2026-04-25T12:00:00.000Z',
    });
  });

  it('Get returns last_value:null for a property that has never received a value', async () => {
    // The MCU side only publishes when it has data; a fresh property responds
    // with no last_value. Downstream nodes must see explicit `null`, not
    // `undefined` (which n8n's UI renders as a missing field).
    mockedApi.getProperty.mockResolvedValue({
      id: 'prop-1',
      name: 'Brand new',
      variable_name: 'fresh',
      type: 'INT',
      permission: 'READ_WRITE',
    });
    const out = await run(makeCtx([{}], { operation: 'get' }));
    expect(out[0].json.last_value).toBeNull();
    expect(out[0].json.value_updated_at).toBeNull();
  });

  it('GetHistory with empty results returns count:0 and an empty points array', async () => {
    mockedApi.historicData.mockResolvedValue([]);
    const out = await run(makeCtx([{}], { operation: 'getHistory' }));
    expect(out[0].json.count).toBe(0);
    expect(out[0].json.points).toEqual([]);
  });
});

describe('ArduinoCloud — boundary contracts the README commits to', () => {
  beforeEach(() => {
    __resetRateLimiterForTests();
    mockedApi.getProperty.mockReset();
    mockedApi.publishProperty.mockReset();
    mockedApi.historicData.mockReset();
  });

  it('Location-shaped object from an n8n expression reaches the API unchanged', async () => {
    // Master plan §13.4: "Location variables — accept { lat, lon } at the
    // node boundary, convert to the SDK's shape internally." The current
    // contract is "pass through unchanged"; if that ever changes, this test
    // should be updated alongside.
    mockedApi.publishProperty.mockResolvedValue(undefined);
    await run(
      makeCtx([{}], { operation: 'set', value: { lat: 45.5, lon: 9.2 } }),
    );
    expect(mockedApi.publishProperty).toHaveBeenCalledWith(
      expect.anything(),
      'thing-1',
      'prop-1',
      { lat: 45.5, lon: 9.2 },
    );
  });

  it('explicit JSON parse failure surfaces a clear error, not an opaque 400 later', async () => {
    // The README promises type errors surface in the node's error output
    // with a clear message, not as an opaque 400 from Arduino Cloud.
    mockedApi.publishProperty.mockResolvedValue(undefined);
    await expect(
      run(makeCtx([{}], { operation: 'set', value: '{notjson}', valueType: 'json' })),
    ).rejects.toThrow(/not valid JSON/);
    expect(mockedApi.publishProperty).not.toHaveBeenCalled();
  });

  it('GetHistory defaults to "last hour" when both From and To are blank', async () => {
    // The "is today unusual? what was the temperature at 3am yesterday?"
    // story relies on the LLM being able to call this with no time args
    // and get a useful window back. Lock the default to 1h.
    mockedApi.historicData.mockResolvedValue([
      { property_id: 'prop-1', from: '', to: '', points: [] },
    ]);
    const before = Date.now();
    await run(makeCtx([{}], { operation: 'getHistory' }));
    const after = Date.now();

    const [, , from, to] = mockedApi.historicData.mock.calls[0];
    expect(to.getTime()).toBeGreaterThanOrEqual(before);
    expect(to.getTime()).toBeLessThanOrEqual(after);
    expect(to.getTime() - from.getTime()).toBe(60 * 60 * 1000);
  });
});

describe('ArduinoCloud — LLM safety contracts', () => {
  beforeEach(() => {
    __resetRateLimiterForTests();
    mockedApi.getProperty.mockReset();
    mockedApi.publishProperty.mockReset();
  });

  it('Property Guard rejection returns the guard string verbatim and skips the API call', async () => {
    // The differentiated value of this node is "the agent reads the
    // rejection string and self-corrects". The exact wording the user wrote
    // must reach the tool-output channel unchanged. And the API must NOT
    // be called — otherwise a "no, don't do this" guard still moves the
    // device.
    mockedApi.publishProperty.mockResolvedValue(undefined);
    const out = await run(
      makeCtx([{}], {
        operation: 'set',
        value: '99',
        propertyGuard: 'return "Refused: setpoint must be 15-26 degrees";',
      }),
    );
    expect(out[0].json.refused).toBe(true);
    expect(out[0].json.error).toBe('Refused: setpoint must be 15-26 degrees');
    expect(mockedApi.publishProperty).not.toHaveBeenCalled();
  });

  it('rate-limit rejection short-circuits the guard (guard never runs)', async () => {
    // If the guard ran past the cap, a guard with side effects (e.g.
    // counting "tool considered" or hitting an external policy server)
    // would over-fire. The cap is the outer gate.
    mockedApi.getProperty.mockResolvedValue(STD_PROP);
    const guardKey = Symbol.for('test:cloudGuardRan:' + Math.random());
    (globalThis as Record<symbol, number>)[guardKey] = 0;
    const guardBody = `globalThis[Symbol.for('${guardKey.description}')]++; return true;`;

    await run(
      makeCtx([{}, {}, {}], {
        operation: 'get',
        rateLimit: { maxCalls: 2, window: 'minute' },
        propertyGuard: guardBody,
      }),
    );

    expect((globalThis as Record<symbol, number>)[guardKey]).toBe(2);
  });

  it('guard rejection does NOT consume rate-limit budget', async () => {
    // Otherwise a guard that says "you keep getting the temperature wrong,
    // try again with a saner value" eats the LLM's whole hourly budget.
    // The legitimate retries that follow must still go through.
    mockedApi.getProperty.mockResolvedValue(STD_PROP);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__cloudGuardN = 0;

    const out = await run(
      makeCtx([{}, {}, {}, {}], {
        operation: 'get',
        rateLimit: { maxCalls: 2, window: 'minute' },
        propertyGuard: `
          globalThis.__cloudGuardN = (globalThis.__cloudGuardN || 0) + 1;
          if (globalThis.__cloudGuardN % 2 === 0) return "Refused: even-numbered call";
          return true;
        `,
      }),
    );

    // Two reject (items 2 & 4), two pass through (items 1 & 3). Cap=2 is
    // not exhausted by the rejects.
    expect(out[0].json.refused).toBeUndefined();
    expect(out[1].json.refused).toBe(true);
    expect(out[2].json.refused).toBeUndefined();
    expect(out[3].json.refused).toBe(true);
    expect(mockedApi.getProperty).toHaveBeenCalledTimes(2);
  });

  it('rate-limit rejection includes a "retry in ~Xs" message the LLM can act on', async () => {
    // The whole point of this string is to be readable to the agent. Lock
    // the shape so a future refactor doesn't silently turn it into JSON
    // or otherwise change the ergonomics.
    mockedApi.getProperty.mockResolvedValue(STD_PROP);
    const out = await run(
      makeCtx([{}, {}], {
        operation: 'get',
        rateLimit: { maxCalls: 1, window: 'minute' },
      }),
    );
    expect(out[1].json.refused).toBe(true);
    expect(out[1].json.error).toMatch(
      /Refused: rate limit of 1 per minute exceeded\. Retry in ~\d+s\./,
    );
  });

  it('budget.used and budget.remaining inside the guard reflect calls landing in real time', async () => {
    // This is the documented contract for users writing guards: the budget
    // object exposes a live view of prior successful calls. If `used`
    // didn't increment, "soft cap" patterns (e.g. "warn the LLM at 80% of
    // the limit") would silently break.
    mockedApi.getProperty.mockResolvedValue(STD_PROP);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__seen = [];
    await run(
      makeCtx([{}, {}, {}], {
        operation: 'get',
        rateLimit: { maxCalls: 5, window: 'minute' },
        propertyGuard: `
          globalThis.__seen.push({ used: budget.used("minute"), remaining: budget.remaining });
          return true;
        `,
      }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).__seen).toEqual([
      { used: 0, remaining: 5 },
      { used: 1, remaining: 4 },
      { used: 2, remaining: 3 },
    ]);
  });

  it('budget.remaining is null when no cap is configured (guards can detect "no cap")', async () => {
    // A guard that wants to enforce a cap *only when none is configured at
    // the node level* needs a way to ask. Document and lock the answer.
    mockedApi.getProperty.mockResolvedValue(STD_PROP);
    const out = await run(
      makeCtx([{}], {
        operation: 'get',
        propertyGuard: 'return JSON.stringify({ r: budget.remaining, t: budget.resetsInMs });',
      }),
    );
    expect(JSON.parse(out[0].json.error)).toEqual({ r: null, t: null });
  });
});

describe('ArduinoCloud — n8n integration contracts', () => {
  beforeEach(() => {
    __resetRateLimiterForTests();
    mockedApi.getProperty.mockReset();
    mockedApi.publishProperty.mockReset();
  });

  it('continueOnFail: a per-item API failure surfaces as an error item, not a workflow abort', async () => {
    mockedApi.getProperty.mockRejectedValue(new Error('network down'));
    const out = await run(
      makeCtx([{}, {}], { operation: 'get' }, { continueOnFail: true }),
    );
    expect(out).toHaveLength(2);
    expect(out[0].json).toEqual({ error: 'network down' });
    expect(out[1].json).toEqual({ error: 'network down' });
  });

  it('rate-limit counter is keyed per (operation, propertyId) — get and set on the same property have independent budgets', async () => {
    // Documented intent: "rate-limiting the MCU, not the node". A user who
    // writes a value, then immediately reads it back to confirm, must not
    // burn the read budget on the write. Different operations on the same
    // node/thing/property have independent counters.
    mockedApi.getProperty.mockResolvedValue(STD_PROP);
    mockedApi.publishProperty.mockResolvedValue(undefined);

    // Saturate Get budget.
    const ctxGet = makeCtx(
      [{}, {}, {}],
      { operation: 'get', rateLimit: { maxCalls: 2, window: 'minute' } },
      { nodeId: 'node-A' },
    );
    const outGet = await run(ctxGet);
    expect(outGet[2].json.refused).toBe(true);

    // Set on the same node/thing/property still has a full budget.
    const ctxSet = makeCtx(
      [{}, {}],
      {
        operation: 'set',
        value: '1',
        rateLimit: { maxCalls: 2, window: 'minute' },
      },
      { nodeId: 'node-A' },
    );
    const outSet = await run(ctxSet);
    expect(outSet.every((r) => !r.json.refused)).toBe(true);
    expect(mockedApi.publishProperty).toHaveBeenCalledTimes(2);
  });
});
