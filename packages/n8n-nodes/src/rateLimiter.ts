/**
 * Process-wide call-history store for the UnoQTool node.
 *
 * State lives on globalThis under a Symbol.for key for the same reason
 * BridgeManager does: each node file is bundled independently by esbuild,
 * so module-level state would otherwise be per-bundle. Counters are in-memory
 * only — they reset on container restart and are not shared across queue-mode
 * workers.
 *
 * Design: query and record are separate primitives. The Rate Limit field
 * enforces a cap by *querying* the history (checkRateLimit), and the method
 * guard inspects the same history via `budget.used(window)` — so the guard
 * sees call volume whether or not a cap is configured. A call is *recorded*
 * via recordCall only after it has passed both gates, so a rejected call
 * does not eat future budget.
 */
const SINGLETON_KEY = Symbol.for('@raasimpact/arduino-uno-q/rate-limiter');

export type RateLimitWindow = 'minute' | 'hour' | 'day';

export const WINDOW_MS: Record<RateLimitWindow, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

export type RateLimitVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

interface Store {
  counters: Map<string, number[]>;
}

function getStore(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  if (!g[SINGLETON_KEY]) {
    g[SINGLETON_KEY] = { counters: new Map() };
  }
  return g[SINGLETON_KEY]!;
}

/** Return timestamps for `key` that fall within `windowMs` of `now`, in order. */
function activeTimestamps(key: string, windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  const ts = getStore().counters.get(key) ?? [];
  return ts.filter((t) => t > cutoff);
}

/**
 * Query-only: does the configured cap have room for another call right now?
 * Does not record anything — the caller records the call via recordCall once
 * all gates have passed.
 */
export function checkRateLimit(
  key: string,
  maxCalls: number,
  window: RateLimitWindow,
  now: number = Date.now(),
): RateLimitVerdict {
  const windowMs = WINDOW_MS[window];
  const active = activeTimestamps(key, windowMs, now);
  if (active.length >= maxCalls) {
    const oldest = active[0];
    return { allowed: false, retryAfterMs: Math.max(0, oldest + windowMs - now) };
  }
  return { allowed: true };
}

/** Count calls to `key` that occurred within the last `window`. */
export function countInWindow(
  key: string,
  window: RateLimitWindow,
  now: number = Date.now(),
): number {
  return activeTimestamps(key, WINDOW_MS[window], now).length;
}

/**
 * ms until the oldest in-window call rolls off — i.e., when one slot frees up.
 * Returns null when the window holds no calls (nothing to reset).
 */
export function resetsInMs(
  key: string,
  window: RateLimitWindow,
  now: number = Date.now(),
): number | null {
  const windowMs = WINDOW_MS[window];
  const active = activeTimestamps(key, windowMs, now);
  if (active.length === 0) return null;
  return Math.max(0, active[0] + windowMs - now);
}

/**
 * Record a call at `now`. Trims to the day retention window so memory stays
 * bounded even for a busy tool that never rolls its counter over.
 */
export function recordCall(key: string, now: number = Date.now()): void {
  const store = getStore();
  const cutoff = now - WINDOW_MS.day;
  const existing = (store.counters.get(key) ?? []).filter((t) => t > cutoff);
  existing.push(now);
  store.counters.set(key, existing);
}

/** Test-only: drop all counters. */
export function __resetRateLimiterForTests(): void {
  getStore().counters.clear();
}
