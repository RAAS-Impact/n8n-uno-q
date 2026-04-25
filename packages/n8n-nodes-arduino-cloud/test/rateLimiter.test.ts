import { beforeEach, describe, expect, it } from 'vitest';
import {
  WINDOW_MS,
  __resetRateLimiterForTests,
  checkRateLimit,
  countInWindow,
  recordCall,
  resetsInMs,
} from '../src/rateLimiter.js';

describe('rateLimiter', () => {
  beforeEach(() => {
    __resetRateLimiterForTests();
  });

  it('allows up to the cap and rejects beyond', () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) recordCall('k', t);
    expect(checkRateLimit('k', 3, 'minute', t + 1000).allowed).toBe(false);
    expect(checkRateLimit('k', 4, 'minute', t + 1000).allowed).toBe(true);
  });

  it('reports retry delay based on oldest in-window call', () => {
    const t = 1_000_000;
    recordCall('k', t);
    recordCall('k', t + 5_000);
    const v = checkRateLimit('k', 2, 'minute', t + 10_000);
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.retryAfterMs).toBe(WINDOW_MS.minute - 10_000);
    }
  });

  it('rolls off calls past the window', () => {
    const t = 1_000_000;
    recordCall('k', t);
    expect(countInWindow('k', 'minute', t + 30_000)).toBe(1);
    expect(countInWindow('k', 'minute', t + WINDOW_MS.minute + 1)).toBe(0);
  });

  it('resetsInMs returns null when empty and a positive number otherwise', () => {
    expect(resetsInMs('empty', 'minute', 1_000_000)).toBeNull();
    recordCall('k', 1_000_000);
    expect(resetsInMs('k', 'minute', 1_000_000 + 10_000)).toBe(WINDOW_MS.minute - 10_000);
  });

  it('counters are independent per key', () => {
    for (let i = 0; i < 5; i++) recordCall('a');
    expect(countInWindow('a', 'minute')).toBe(5);
    expect(countInWindow('b', 'minute')).toBe(0);
  });
});
