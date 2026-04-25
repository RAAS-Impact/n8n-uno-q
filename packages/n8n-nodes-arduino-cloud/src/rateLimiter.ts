/**
 * Process-wide call-history store for the ArduinoCloud node.
 *
 * Same design as the n8n-nodes-uno-q rateLimiter — see the companion file for
 * the full rationale. State lives on globalThis under a package-specific
 * Symbol.for key so the counters are isolated from the uno-q package even
 * when both are installed in the same n8n instance.
 *
 * Query and record are separate primitives: the Rate Limit field enforces a
 * cap by *querying* (checkRateLimit), the guard inspects the same history via
 * `budget.used(window)`, and a call is only *recorded* after it has passed
 * both gates — so a rejected call does not eat future budget.
 */
const SINGLETON_KEY = Symbol.for('@raasimpact/arduino-cloud/rate-limiter');

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

function activeTimestamps(key: string, windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  const ts = getStore().counters.get(key) ?? [];
  return ts.filter((t) => t > cutoff);
}

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

export function countInWindow(
  key: string,
  window: RateLimitWindow,
  now: number = Date.now(),
): number {
  return activeTimestamps(key, WINDOW_MS[window], now).length;
}

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
