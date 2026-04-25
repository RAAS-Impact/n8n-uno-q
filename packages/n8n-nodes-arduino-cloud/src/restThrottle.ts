/**
 * Per-credential token bucket for the Arduino Cloud REST API.
 *
 * The Cloud REST budget is 10 req/s per authenticated client; exceeding it
 * yields 429s with no body the SDK can usefully decode. The bucket is the
 * difference between "a few nodes working" and "your whole workflow blows
 * up the moment you list properties on a busy account."
 *
 * Two design choices worth noting:
 *
 *   - Per-credential, not global. A single n8n instance with two Arduino
 *     Cloud credentials gets two 10/s budgets — Arduino's quota is keyed
 *     to the OAuth2 client, not the host.
 *   - Strict FIFO via a serialised Promise chain. A naive "while → sleep"
 *     spin lets bursts of waiters all wake at the same instant and tear
 *     through the just-refilled tokens (thundering herd). The chain
 *     keeps order and prevents that.
 *
 * State lives on globalThis under a package-specific Symbol.for so the
 * counters are isolated from anything else and survive the per-node
 * esbuild bundling (each node bundle gets its own copy of this file
 * otherwise — same hazard CloudClientManager solves).
 */
const SINGLETON_KEY = Symbol.for('@raasimpact/arduino-cloud/rest-throttle');

const CAPACITY = 10; // tokens
const RATE_PER_SEC = 10; // tokens per second

interface BucketState {
  tokens: number;
  lastRefill: number;
  /** Tail of the FIFO promise chain — every acquire() appends to it. */
  chain: Promise<void>;
}

interface Store {
  buckets: Map<string, BucketState>;
}

function getStore(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  if (!g[SINGLETON_KEY]) {
    g[SINGLETON_KEY] = { buckets: new Map() };
  }
  return g[SINGLETON_KEY]!;
}

function bucketFor(key: string): BucketState {
  const store = getStore();
  let b = store.buckets.get(key);
  if (!b) {
    b = { tokens: CAPACITY, lastRefill: Date.now(), chain: Promise.resolve() };
    store.buckets.set(key, b);
  }
  return b;
}

function refill(b: BucketState, now: number): void {
  const elapsedMs = now - b.lastRefill;
  if (elapsedMs <= 0) return;
  b.tokens = Math.min(CAPACITY, b.tokens + (elapsedMs * RATE_PER_SEC) / 1000);
  b.lastRefill = now;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Block until a token is available for the given credential, then consume
 * it. Call before every REST request. Idempotent across concurrent
 * callers — first-in, first-out.
 */
export async function acquireRestToken(credentialKey: string): Promise<void> {
  const b = bucketFor(credentialKey);
  // Append this acquire to the FIFO chain. Each link consumes one token,
  // sleeping if necessary until refill catches up.
  const next = b.chain.then(async () => {
    refill(b, Date.now());
    if (b.tokens < 1) {
      const waitMs = Math.max(1, Math.ceil(((1 - b.tokens) * 1000) / RATE_PER_SEC));
      await sleep(waitMs);
      refill(b, Date.now());
    }
    b.tokens -= 1;
  });
  // Keep the chain alive even if a caller throws after acquire — the
  // throw belongs to the caller's promise, not the throttle's.
  b.chain = next.catch(() => {});
  return next;
}

/** Test-only: drop all bucket state. */
export function __resetRestThrottleForTests(): void {
  getStore().buckets.clear();
}
