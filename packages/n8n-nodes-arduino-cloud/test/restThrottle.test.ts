/**
 * REST throttle — invariant tests.
 *
 * These verify the timing properties that the bucket exists to deliver:
 *
 *   - Up to CAPACITY (10) concurrent calls go through immediately — bursts
 *     don't pay an unnecessary tax.
 *   - Beyond CAPACITY, the (capacity+1)th call is delayed until refill
 *     catches up; we don't burn through the bucket and then 429 silently.
 *   - Two distinct credentials each get their own 10/s budget — Arduino's
 *     quota is keyed on the OAuth2 client, not on the host.
 *   - FIFO ordering — late acquirers don't get to skip the queue.
 *
 * Real-time tests, not fake timers: the bucket is built on Date.now() and
 * setTimeout, and the values we care about are seconds, not milliseconds —
 * so we can afford a real 1-second wait in CI.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetRestThrottleForTests,
  acquireRestToken,
} from '../src/restThrottle.js';

afterEach(() => __resetRestThrottleForTests());

describe('REST throttle', () => {
  it('lets a burst of 10 acquires complete in well under one refill interval', async () => {
    // Capacity is 10 and the bucket starts full — all 10 must resolve
    // promptly. If this test ever takes >100 ms the bucket is leaking
    // serial latency into bursts that should be free.
    const started = Date.now();
    await Promise.all(
      Array.from({ length: 10 }, () => acquireRestToken('cred-A')),
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(100);
  });

  it('an 11th acquire waits at least ~100ms (one refill interval at 10/s)', async () => {
    // After 10 acquires the bucket is empty. The 11th has to wait for one
    // token's worth of refill — at 10 tokens/s that's ~100 ms. We allow
    // a generous floor (80 ms) because timer resolution can drift slightly
    // negative on macOS, and a generous ceiling because vitest setup +
    // network noise can absorb time.
    await Promise.all(
      Array.from({ length: 10 }, () => acquireRestToken('cred-A')),
    );
    const started = Date.now();
    await acquireRestToken('cred-A');
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(500);
  });

  it('25 sequential-style concurrent acquires take ~1.5s — the rate floor for the excess', async () => {
    // 25 acquires on a bucket of 10 at 10/s: first 10 free, then 15 more
    // at 10/s = 1.5s. We assert >=1.3s so the test doesn't flake on a
    // fast machine where small timer drifts reduce the wait, but anything
    // under 1.0s would mean the bucket is under-throttling and a real
    // workflow with that many parallel calls would 429.
    const started = Date.now();
    await Promise.all(
      Array.from({ length: 25 }, () => acquireRestToken('cred-A')),
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1300);
    expect(elapsed).toBeLessThan(2500);
  }, 5000);

  it('two distinct credentials each consume their own bucket', async () => {
    // Saturating cred-A's bucket must not delay cred-B's first 10. If the
    // bucket were global, cred-B would inherit cred-A's exhaustion and
    // every multi-account user would see false serialisation.
    await Promise.all(
      Array.from({ length: 10 }, () => acquireRestToken('cred-A')),
    );
    const started = Date.now();
    await Promise.all(
      Array.from({ length: 10 }, () => acquireRestToken('cred-B')),
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(100);
  });

  it('preserves FIFO order: the Nth acquire to enter is the Nth to resolve', async () => {
    // Acquire 15 in a row immediately (10 free + 5 blocked). The blocked
    // five must resolve in their submission order, not whichever timer
    // happened to fire first. A bug in the chain would let a later
    // submission sneak ahead and the LLM-driven workflow would see
    // out-of-order results.
    const order: number[] = [];
    const promises = Array.from({ length: 15 }, (_, i) =>
      acquireRestToken('cred-A').then(() => order.push(i)),
    );
    await Promise.all(promises);
    expect(order).toEqual(Array.from({ length: 15 }, (_, i) => i));
  }, 5000);
});
