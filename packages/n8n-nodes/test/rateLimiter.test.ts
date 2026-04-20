import { beforeEach, describe, expect, it } from 'vitest';
import {
  WINDOW_MS,
  __resetRateLimiterForTests,
  checkRateLimit,
  countInWindow,
  recordCall,
  resetsInMs,
} from '../src/rateLimiter.js';

describe('rateLimiter primitives', () => {
  beforeEach(() => {
    __resetRateLimiterForTests();
  });

  describe('checkRateLimit (query-only)', () => {
    it('allows as long as recorded calls stay under the cap', () => {
      const t = 1_000_000;
      for (let i = 0; i < 4; i++) recordCall('k', t + i);
      expect(checkRateLimit('k', 5, 'minute', t + 10).allowed).toBe(true);
    });

    it('rejects once recorded calls reach the cap and reports retry time', () => {
      const t = 1_000_000;
      for (let i = 0; i < 3; i++) recordCall('k', t);
      const v = checkRateLimit('k', 3, 'minute', t + 1000);
      expect(v.allowed).toBe(false);
      if (!v.allowed) {
        expect(v.retryAfterMs).toBe(WINDOW_MS.minute - 1000);
      }
    });

    it('is idempotent — repeated checks do not eat budget', () => {
      const t = 1_000_000;
      recordCall('k', t);
      for (let i = 0; i < 10; i++) {
        expect(checkRateLimit('k', 2, 'minute', t + i).allowed).toBe(true);
      }
      expect(countInWindow('k', 'minute', t + 100)).toBe(1);
    });

    it('slides: oldest timestamp falling out of window frees a slot', () => {
      const t = 1_000_000;
      recordCall('k', t);
      recordCall('k', t + 1000);
      expect(checkRateLimit('k', 2, 'minute', t + 2000).allowed).toBe(false);

      const after = t + WINDOW_MS.minute + 1;
      expect(checkRateLimit('k', 2, 'minute', after).allowed).toBe(true);
    });
  });

  describe('countInWindow', () => {
    it('returns 0 for an unknown key', () => {
      expect(countInWindow('nope', 'minute')).toBe(0);
    });

    it('counts only calls within the given window', () => {
      const t = 1_000_000;
      recordCall('k', t - 2 * WINDOW_MS.minute); // outside minute, inside hour
      recordCall('k', t - 30_000); // inside minute
      recordCall('k', t - 5000); // inside minute

      expect(countInWindow('k', 'minute', t)).toBe(2);
      expect(countInWindow('k', 'hour', t)).toBe(3);
      expect(countInWindow('k', 'day', t)).toBe(3);
    });
  });

  describe('resetsInMs', () => {
    it('is null when no calls are in the window', () => {
      expect(resetsInMs('k', 'minute')).toBeNull();
      recordCall('k', 1_000_000);
      expect(resetsInMs('k', 'minute', 1_000_000 + WINDOW_MS.minute + 1)).toBeNull();
    });

    it('returns time until the oldest in-window call rolls off', () => {
      const t = 1_000_000;
      recordCall('k', t);
      recordCall('k', t + 10_000);
      expect(resetsInMs('k', 'minute', t + 15_000)).toBe(WINDOW_MS.minute - 15_000);
    });
  });

  describe('recordCall', () => {
    it('scopes counters per key', () => {
      const t = 1_000_000;
      recordCall('a', t);
      expect(countInWindow('a', 'minute', t)).toBe(1);
      expect(countInWindow('b', 'minute', t)).toBe(0);
    });

    it('trims timestamps beyond the day retention on write', () => {
      const t = 1_000_000_000_000;
      recordCall('k', t - WINDOW_MS.day - 1000);
      recordCall('k', t - WINDOW_MS.day / 2);
      recordCall('k', t);

      // The oldest timestamp was past day retention; recordCall should have
      // trimmed it so only the last two survive.
      expect(countInWindow('k', 'day', t)).toBe(2);
    });
  });
});
