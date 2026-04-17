/**
 * Integration tests — run against a real arduino-router on the UNO Q.
 *
 * Tests are split into two groups:
 *   - "router / Node-to-Node" — only need the router running, no specific MCU sketch
 *   - "MCU (bridge-test.ino)" — require sketches/bridge-test/bridge-test.ino to be flashed
 *
 * Usage (SSH tunnel from the PC):
 *   rm -f /tmp/arduino-router.sock && ssh -N -L /tmp/arduino-router.sock:/var/run/arduino-router.sock arduino@linucs.local &
 *   UNOQ_SOCKET=/tmp/arduino-router.sock npm run test:integration -w packages/bridge
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Bridge } from '../src/index.js';

const SOCKET = process.env.UNOQ_SOCKET;
const SKIP = !SOCKET;

function connect() {
  return Bridge.connect({ socket: SOCKET, reconnect: { enabled: false } });
}

describe.skipIf(SKIP)('router / Node-to-Node', () => {
  let bridge: Bridge | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it('$/version returns a non-empty string', async () => {
    bridge = await connect();
    const version = await bridge.call('$/version');
    expect(typeof version).toBe('string');
    expect((version as string).length).toBeGreaterThan(0);
  });

  it('callWithTimeout resolves within limit', async () => {
    bridge = await connect();
    const version = await bridge.callWithTimeout('$/version', 2000);
    expect(typeof version).toBe('string');
  });

  it('provide: Node → router → Node round-trip', async () => {
    bridge = await connect();
    const caller = await connect();
    try {
      await bridge.provide('integration_test_echo', (params) => ({ echo: params }));
      const result = await caller.call('integration_test_echo', 'hello', 42) as Record<string, unknown>;
      expect(result.echo).toEqual(['hello', 42]);
    } finally {
      await caller.close();
    }
  });

  it('notify: Node → router → Node delivery', async () => {
    bridge = await connect();
    const received: unknown[][] = [];
    await bridge.onNotify('integration_test_notify', (params) => received.push(params));

    const sender = await connect();
    try {
      sender.notify('integration_test_notify', 'ping');
      await new Promise((r) => setTimeout(r, 200));
      expect(received.length).toBeGreaterThan(0);
    } finally {
      await sender.close();
    }
  });
});

describe.skipIf(SKIP)('MCU (bridge-test.ino)', () => {
  let bridge: Bridge | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it('ping returns "pong"', async () => {
    bridge = await connect();
    expect(await bridge.call('ping')).toBe('pong');
  });

  it('add(2, 3) returns 5', async () => {
    bridge = await connect();
    expect(await bridge.call('add', 2, 3)).toBe(5);
  });

  it('set_led_state / get_led_state round-trip', async () => {
    bridge = await connect();
    await bridge.call('set_led_state', true);
    expect(await bridge.call('get_led_state')).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    await bridge.call('set_led_state', false);
    expect(await bridge.call('get_led_state')).toBe(false);
  });

  it('heartbeat NOTIFY arrives within 7s', async () => {
    bridge = await connect();
    let resolveHB!: (p: unknown[]) => void;
    let rejectHB!: (e: Error) => void;
    const hbPromise = new Promise<unknown[]>((res, rej) => { resolveHB = res; rejectHB = rej; });
    const timeout = setTimeout(() => rejectHB(new Error('no heartbeat within 7s')), 7000);

    await bridge.onNotify('heartbeat', (params) => { clearTimeout(timeout); resolveHB(params); });

    const params = await hbPromise;
    expect(Array.isArray(params)).toBe(true);
  }, 10_000);

  it('gpio_event NOTIFY via fire_test_event (interrupt path)', async () => {
    bridge = await connect();
    const trigger = await connect();
    try {
      let resolveEv!: (p: unknown[]) => void;
      let rejectEv!: (e: Error) => void;
      const evPromise = new Promise<unknown[]>((res, rej) => { resolveEv = res; rejectEv = rej; });
      const timeout = setTimeout(() => rejectEv(new Error('no gpio_event within 2s')), 2000);

      await bridge.onNotify('gpio_event', (p) => { clearTimeout(timeout); resolveEv(p); });
      trigger.call('fire_test_event').catch((err: Error) => { clearTimeout(timeout); rejectEv(err); });

      const params = await evPromise;
      expect(Array.isArray(params)).toBe(true);
      expect(params[0]).toBe(2);
    } finally {
      await trigger.close();
    }
  });
});
