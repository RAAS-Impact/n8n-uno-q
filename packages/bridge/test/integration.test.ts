/**
 * Integration tests — run against a real arduino-router on the UNO Q.
 *
 * Tests are split into two groups:
 *   - "router / Node-to-Node" — only need the router running, no specific MCU sketch
 *   - "MCU (integration-test.ino)" — require sketches/integration-test.ino to be flashed
 *
 * Each group runs once per transport configured via env vars. Multiple env
 * var sets can be populated simultaneously to exercise all three transports
 * in one run.
 *
 *   A. Unix socket (default, legacy) — SSH-tunnel the router socket to the PC:
 *        rm -f /tmp/arduino-router.sock
 *        ssh -N -L /tmp/arduino-router.sock:/var/run/arduino-router.sock arduino@linucs.local &
 *        UNOQ_SOCKET=/tmp/arduino-router.sock npm run test:integration -w packages/bridge
 *
 *   B. TCP (Variant A relay — CONTEXT.md §12.5.1, §12.7 step 1):
 *        On the Q:  cd ~/relay && docker compose up -d
 *        On the PC: ssh -N -L 5775:localhost:5775 arduino@linucs.local &
 *                   UNOQ_TCP_HOST=127.0.0.1 UNOQ_TCP_PORT=5775 \
 *                     npm run test:integration -w packages/bridge
 *
 *   C. TLS (Variant C mTLS relay — CONTEXT.md §12.5.3):
 *        On the PC, after running the pki scripts:
 *          UNOQ_TLS_HOST=127.0.0.1 UNOQ_TLS_PORT=5775 \
 *          UNOQ_TLS_CA=deploy/relay-mtls/pki/out/n8n/laptop/ca.pem \
 *          UNOQ_TLS_CERT=deploy/relay-mtls/pki/out/n8n/laptop/client.pem \
 *          UNOQ_TLS_KEY=deploy/relay-mtls/pki/out/n8n/laptop/client.key \
 *          npm run test:integration -w packages/bridge
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { Bridge } from '../src/index.js';
import type { ConnectOptions } from '../src/index.js';

type TransportCase = { name: string; opts: ConnectOptions };

const transports: TransportCase[] = [];

if (process.env.UNOQ_SOCKET) {
  transports.push({
    name: 'unix',
    opts: { socket: process.env.UNOQ_SOCKET, reconnect: { enabled: false } },
  });
}

if (process.env.UNOQ_TCP_HOST && process.env.UNOQ_TCP_PORT) {
  transports.push({
    name: 'tcp',
    opts: {
      transport: {
        kind: 'tcp',
        host: process.env.UNOQ_TCP_HOST,
        port: Number(process.env.UNOQ_TCP_PORT),
      },
      reconnect: { enabled: false },
    },
  });
}

if (
  process.env.UNOQ_TLS_HOST &&
  process.env.UNOQ_TLS_PORT &&
  process.env.UNOQ_TLS_CA &&
  process.env.UNOQ_TLS_CERT &&
  process.env.UNOQ_TLS_KEY
) {
  // Read cert files synchronously at test-module load time. If any path is
  // wrong, the thrown ENOENT surfaces before the test even registers, which
  // is the clearest failure signal for an integration config error.
  transports.push({
    name: 'tls',
    opts: {
      transport: {
        kind: 'tls',
        host: process.env.UNOQ_TLS_HOST,
        port: Number(process.env.UNOQ_TLS_PORT),
        ca: fs.readFileSync(process.env.UNOQ_TLS_CA, 'utf-8'),
        cert: fs.readFileSync(process.env.UNOQ_TLS_CERT, 'utf-8'),
        key: fs.readFileSync(process.env.UNOQ_TLS_KEY, 'utf-8'),
      },
      reconnect: { enabled: false },
    },
  });
}

// Emit a skip marker when no transport is configured so the file still
// registers with Vitest. Without this, the file looks empty.
if (transports.length === 0) {
  describe.skip('integration', () => {
    it('set UNOQ_SOCKET, UNOQ_TCP_HOST+UNOQ_TCP_PORT, or UNOQ_TLS_* to run', () => {});
  });
}

for (const t of transports) {
  const connect = () => Bridge.connect(t.opts);

  describe(`router / Node-to-Node (${t.name})`, () => {
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

    it('provide: delayed handler (simulates UnoQRespond) still delivers the response', async () => {
      // Mirrors what n8n's UnoQTrigger (deferred) + UnoQRespond do:
      // the provide handler returns a Promise that resolves 5 seconds later.
      // If this passes, the bridge/router path holds delayed responses open
      // correctly and the workflow's 5s delay is not the problem.
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

  describe(`MCU (integration-test.ino) (${t.name})`, () => {
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

    it('gpio_event via fire_test_event (interrupt → MCU Bridge.call path)', async () => {
      bridge = await connect();
      const trigger = await connect();
      try {
        let resolveEv!: (p: unknown[]) => void;
        let rejectEv!: (e: Error) => void;
        const evPromise = new Promise<unknown[]>((res, rej) => { resolveEv = res; rejectEv = rej; });
        const timeout = setTimeout(() => rejectEv(new Error('no gpio_event within 2s')), 2000);

        // The sketch sends `Bridge.call("gpio_event", 2)` from the MCU, so we
        // must act as its handler (provide), not as a notify subscriber.
        await bridge.provide('gpio_event', (p) => { clearTimeout(timeout); resolveEv(p); return null; });
        trigger.call('fire_test_event').catch((err: Error) => { clearTimeout(timeout); rejectEv(err); });

        const params = await evPromise;
        expect(Array.isArray(params)).toBe(true);
        expect(params[0]).toBe(2);
      } finally {
        await trigger.close();
      }
    });
  });
}
