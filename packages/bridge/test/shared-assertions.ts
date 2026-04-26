/**
 * Shared integration assertions — register the same body of expectations
 * against any transport that talks to a real arduino-router.
 *
 * This is the contract every transport (unix / tcp / mtls / ssh) must
 * uphold. Bridge's integration suite runs it for unix/tcp/mtls; the
 * n8n-nodes integration suite runs it for ssh (which depends on
 * SshServer, which lives in n8n-nodes).
 *
 * Two groups:
 *   - "router / Node-to-Node" — only need the router running.
 *   - "MCU (integration-test.ino)" — also need sketches/integration-test.ino
 *     flashed on the board.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Bridge } from '../src/index.js';
import type { ConnectOptions } from '../src/index.js';

/** Either a static ConnectOptions or a thunk for env-dependent setup. */
export type ConnectFactory = () => Promise<ConnectOptions> | ConnectOptions;

export function registerSharedAssertions(transportName: string, factory: ConnectFactory): void {
  const connect = async () => Bridge.connect(await factory());

  describe(`router / Node-to-Node (${transportName})`, () => {
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

    it('three concurrent calls demux correctly', async () => {
      bridge = await connect();
      const results = await Promise.all([
        bridge.call('$/version'),
        bridge.call('$/version'),
        bridge.call('$/version'),
      ]);
      for (const v of results) expect(typeof v).toBe('string');
    });

    it('provide: Node → router → Node round-trip', async () => {
      bridge = await connect();
      const caller = await connect();
      try {
        await bridge.provide('integration_test_echo', (params) => ({ echo: params }));
        const result = (await caller.call('integration_test_echo', 'hello', 42)) as Record<string, unknown>;
        expect(result.echo).toEqual(['hello', 42]);
      } finally {
        await caller.close();
      }
    });

    it('provide: delayed handler (simulates UnoQRespond) still delivers the response', async () => {
      bridge = await connect();
      const caller = await connect();
      try {
        const DELAY_MS = 5000;
        await bridge.provide('integration_test_delayed', () => {
          return new Promise((resolve) => setTimeout(() => resolve({ ok: true }), DELAY_MS));
        });

        const started = Date.now();
        const result = (await caller.callWithTimeout(
          'integration_test_delayed',
          DELAY_MS + 3000,
        )) as Record<string, unknown>;
        const elapsed = Date.now() - started;

        expect(result.ok).toBe(true);
        expect(elapsed).toBeGreaterThanOrEqual(DELAY_MS - 100);
      } finally {
        await caller.close();
      }
    }, 15_000);

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

  describe(`MCU (integration-test.ino) (${transportName})`, () => {
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
      const hbPromise = new Promise<unknown[]>((res, rej) => {
        resolveHB = res;
        rejectHB = rej;
      });
      const timeout = setTimeout(() => rejectHB(new Error('no heartbeat within 7s')), 7000);

      await bridge.onNotify('heartbeat', (params) => {
        clearTimeout(timeout);
        resolveHB(params);
      });

      const params = await hbPromise;
      expect(Array.isArray(params)).toBe(true);
    }, 10_000);

    it('gpio_event via fire_test_event (interrupt → MCU Bridge.call path)', async () => {
      bridge = await connect();
      const trigger = await connect();
      try {
        let resolveEv!: (p: unknown[]) => void;
        let rejectEv!: (e: Error) => void;
        const evPromise = new Promise<unknown[]>((res, rej) => {
          resolveEv = res;
          rejectEv = rej;
        });
        const timeout = setTimeout(() => rejectEv(new Error('no gpio_event within 2s')), 2000);

        await bridge.provide('gpio_event', (p) => {
          clearTimeout(timeout);
          resolveEv(p);
          return null;
        });
        trigger.call('fire_test_event').catch((err: Error) => {
          clearTimeout(timeout);
          rejectEv(err);
        });

        const params = await evPromise;
        expect(Array.isArray(params)).toBe(true);
        expect(params[0]).toBe(2);
      } finally {
        await trigger.close();
      }
    });

    it('gpio_event: router forwards MCU interrupt to bridge without handler → patched error to MCU + caller', async () => {
      bridge = await connect();
      const trigger = await connect();
      const caller = await connect();
      let handlerInvocations = 0;
      try {
        await bridge.provide('gpio_event', () => {
          handlerInvocations += 1;
          return 'should-never-run';
        });
        (bridge as unknown as { providers: Map<string, unknown> }).providers.delete('gpio_event');

        trigger.call('fire_test_event').catch(() => {
          /* MCU error path; not asserted here */
        });

        await expect(caller.call('gpio_event', 2)).rejects.toThrow('no handler registered for method: gpio_event');
        expect(handlerInvocations).toBe(0);
      } finally {
        await trigger.close();
        await caller.close();
      }
    });
  });
}
