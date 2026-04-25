/**
 * Arduino Cloud OAuth2 token cache — process-wide singleton.
 *
 * Arduino ships two JS SDKs that need to authenticate against api2.arduino.cc:
 *
 *   - `@arduino/arduino-iot-client` (REST) — expects a pre-fetched bearer
 *     token installed on `ApiClient.authentications.oauth2.accessToken`.
 *     The SDK does not refresh. We manage the token here.
 *
 *   - `arduino-iot-js` (realtime MQTT-over-WSS) — accepts `clientId` +
 *     `clientSecret` directly and fetches its own token internally. It does
 *     refresh, but its cache is per-CloudClient-instance and not shared with
 *     the REST path.
 *
 * Both paths share the same client_credentials grant, so a single cache keyed
 * by client ID (+ optional org) saves a roundtrip on every workflow run.
 * Only the REST path consults this cache today; the realtime SDK keeps its
 * own. That's fine — the point of this module is to stop the REST path from
 * re-minting a token on every single invocation.
 *
 * State lives on globalThis because each node file is bundled independently
 * by esbuild — module-level state would be per-bundle. Matches the pattern
 * used by BridgeManager in the uno-q package.
 */
const SINGLETON_KEY = Symbol.for('@raasimpact/arduino-cloud/token-cache');

/**
 * Default OAuth2 token endpoint. Exposed only for test injection; production
 * callers should never override this.
 */
export const DEFAULT_TOKEN_URL = 'https://api2.arduino.cc/iot/v1/clients/token';
export const DEFAULT_AUDIENCE = 'https://api2.arduino.cc/iot';

/** Refresh this long before expiry so in-flight calls don't see a 401. */
const EXPIRY_SAFETY_MARGIN_MS = 30_000;

export interface TokenRequest {
  clientId: string;
  clientSecret: string;
  organizationId?: string;
}

export interface CachedToken {
  accessToken: string;
  /** Absolute ms epoch when the server says the token expires. */
  expiresAt: number;
}

interface CacheEntry {
  token: CachedToken | null;
  /** In-flight fetch — concurrent callers coalesce on this promise. */
  pending: Promise<CachedToken> | null;
}

interface Store {
  entries: Map<string, CacheEntry>;
  /**
   * Injected fetch for tests. Production path goes through the global fetch.
   */
  fetchFn: typeof fetch;
  /** Injected clock for tests. */
  now: () => number;
}

function getStore(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  if (!g[SINGLETON_KEY]) {
    g[SINGLETON_KEY] = {
      entries: new Map(),
      fetchFn: fetch,
      now: Date.now,
    };
  }
  return g[SINGLETON_KEY]!;
}

function cacheKey(req: TokenRequest): string {
  // Secret is part of the key so that editing a credential (which may change
  // only the secret while keeping the client ID) cannot return the stale
  // token minted against the old secret. Not a security property — the cache
  // is in-process — just a correctness one.
  return `${req.clientId}\0${req.clientSecret}\0${req.organizationId ?? ''}`;
}

function getEntry(key: string): CacheEntry {
  const store = getStore();
  let entry = store.entries.get(key);
  if (!entry) {
    entry = { token: null, pending: null };
    store.entries.set(key, entry);
  }
  return entry;
}

/**
 * Fetch a fresh token from Arduino's OAuth endpoint. Exposed for the
 * credential's Test Connection flow, which wants a real network round-trip
 * every time rather than a cached result.
 */
export async function fetchToken(
  req: TokenRequest,
  tokenUrl: string = DEFAULT_TOKEN_URL,
): Promise<CachedToken> {
  const store = getStore();
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: req.clientId,
    client_secret: req.clientSecret,
    audience: DEFAULT_AUDIENCE,
  });
  if (req.organizationId) body.set('organization_id', req.organizationId);

  const res = await store.fetchFn(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    // Arduino returns JSON-shaped errors on 4xx with a `message` field; fall
    // back to the status line for network-layer failures or unexpected shapes.
    let detail = `${res.status} ${res.statusText}`;
    try {
      const payload = (await res.json()) as { message?: string; error?: string };
      const msg = payload.message ?? payload.error;
      if (msg) detail = `${detail} — ${msg}`;
    } catch {
      /* ignore — detail already populated */
    }
    throw new Error(`Arduino Cloud token request failed: ${detail}`);
  }

  const payload = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!payload.access_token || typeof payload.expires_in !== 'number') {
    throw new Error(
      'Arduino Cloud token response missing access_token or expires_in',
    );
  }
  return {
    accessToken: payload.access_token,
    expiresAt: store.now() + payload.expires_in * 1000,
  };
}

/**
 * Return a valid access token, fetching a fresh one only when the cache is
 * empty or within the safety margin of expiring. Concurrent callers share
 * the same in-flight fetch.
 */
export async function getAccessToken(req: TokenRequest): Promise<string> {
  const store = getStore();
  const key = cacheKey(req);
  const entry = getEntry(key);

  if (entry.token && entry.token.expiresAt - store.now() > EXPIRY_SAFETY_MARGIN_MS) {
    return entry.token.accessToken;
  }

  if (entry.pending) {
    const token = await entry.pending;
    return token.accessToken;
  }

  entry.pending = (async () => {
    try {
      const token = await fetchToken(req);
      entry.token = token;
      return token;
    } finally {
      entry.pending = null;
    }
  })();

  const token = await entry.pending;
  return token.accessToken;
}

/** Test-only: clear all cache entries and reset injected hooks. */
export function __resetTokenCacheForTests(hooks?: {
  fetch?: typeof fetch;
  now?: () => number;
}): void {
  const store = getStore();
  store.entries.clear();
  store.fetchFn = hooks?.fetch ?? fetch;
  store.now = hooks?.now ?? Date.now;
}
