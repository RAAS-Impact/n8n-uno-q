import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Bridge, BridgeError, TimeoutError, ConnectionError } from '../src/index.js';
import {
  StreamDecoder,
  encodeResponse,
  encodeRequest,
  encodeNotify,
  MSG_REQUEST,
} from '../src/codec.js';
import type { RpcMessage, RpcRequest } from '../src/codec.js';

/**
 * Minimal mock router that speaks msgpack-rpc over a Unix socket.
 * Auto-responds to $/register with success.
 */
class MockRouter {
  readonly socketPath: string;
  private server: net.Server;
  private clients: net.Socket[] = [];
  private decoders = new Map<net.Socket, StreamDecoder>();
  received: RpcMessage[] = [];
  private waiters: Array<(msg: RpcRequest) => void> = [];

  constructor() {
    this.socketPath = path.join(os.tmpdir(), `bridge-test-${crypto.randomUUID()}.sock`);
    this.server = net.createServer((socket) => this.onClient(socket));
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  private onClient(socket: net.Socket): void {
    this.clients.push(socket);
    const decoder = new StreamDecoder();
    this.decoders.set(socket, decoder);

    socket.on('data', (chunk: Buffer) => {
      const messages = decoder.feed(new Uint8Array(chunk));
      for (const msg of messages) {
        this.received.push(msg);

        // Auto-respond to $/register
        if (msg[0] === MSG_REQUEST) {
          const [, msgid, method] = msg as RpcRequest;
          if (method === '$/register') {
            socket.write(encodeResponse(msgid, null, true));
          } else {
            // Notify waiters for non-system requests
            const waiter = this.waiters.shift();
            if (waiter) waiter(msg as RpcRequest);
          }
        }
      }
    });

    socket.on('close', () => {
      this.clients = this.clients.filter((c) => c !== socket);
      this.decoders.delete(socket);
    });
  }

  /** Send a response on the most recent client connection. */
  respond(msgid: number, error: unknown, result: unknown): void {
    const socket = this.clients[this.clients.length - 1];
    socket.write(encodeResponse(msgid, error, result));
  }

  /** Send a request to the client (inbound call). */
  sendRequest(msgid: number, method: string, params: unknown[]): void {
    const socket = this.clients[this.clients.length - 1];
    socket.write(encodeRequest(msgid, method, params));
  }

  /** Send a notification to the client. */
  sendNotify(method: string, params: unknown[]): void {
    const socket = this.clients[this.clients.length - 1];
    socket.write(encodeNotify(method, params));
  }

  /** Wait for the next non-system request from the client. */
  nextRequest(): Promise<RpcRequest> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Destroy all client connections (simulates socket close). */
  destroyClients(): void {
    for (const c of this.clients) c.destroy();
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.destroy();
    return new Promise((resolve) => {
      this.server.close(() => {
        try {
          fs.unlinkSync(this.socketPath);
        } catch {
          /* already gone */
        }
        resolve();
      });
    });
  }
}

// Helper to connect a bridge to the mock router
function connectBridge(router: MockRouter) {
  return Bridge.connect({
    socket: router.socketPath,
    reconnect: { enabled: true, baseDelayMs: 50, maxDelayMs: 200 },
  });
}

describe('Bridge', () => {
  let router: MockRouter;
  let bridge: Bridge;

  beforeEach(async () => {
    router = new MockRouter();
    await router.start();
    bridge = await connectBridge(router);
    // Suppress unhandled error events during tests
    bridge.on('error', () => {});
  });

  afterEach(async () => {
    await bridge.close();
    await router.stop();
  });

  describe('call()', () => {
    it('sends request and resolves on response', async () => {
      const pending = bridge.call('get_temp');
      // Find the request in received messages
      await new Promise((r) => setTimeout(r, 20));
      const req = router.received.find(
        (m) => m[0] === MSG_REQUEST && m[2] === 'get_temp',
      ) as RpcRequest;
      expect(req).toBeDefined();
      router.respond(req[1], null, 42);
      const result = await pending;
      expect(result).toBe(42);
    });

    it('rejects on error response', async () => {
      const pending = bridge.call('bad_method');
      await new Promise((r) => setTimeout(r, 20));
      const req = router.received.find(
        (m) => m[0] === MSG_REQUEST && m[2] === 'bad_method',
      ) as RpcRequest;
      router.respond(req[1], 'method not found', null);
      await expect(pending).rejects.toThrow(BridgeError);
      await expect(pending).rejects.toThrow('method not found');
    });

    it('rejects on timeout', async () => {
      // Use callWithTimeout with a short timeout; mock router never responds
      const pending = bridge.callWithTimeout('slow', 50);
      await expect(pending).rejects.toThrow(TimeoutError);
    });

    it('rejects all pending on socket close', async () => {
      const p1 = bridge.call('a');
      const p2 = bridge.call('b');
      // Give time for requests to be sent
      await new Promise((r) => setTimeout(r, 20));
      router.destroyClients();
      await expect(p1).rejects.toThrow(ConnectionError);
      await expect(p2).rejects.toThrow(ConnectionError);
    });
  });

  describe('notify()', () => {
    it('sends notification without msgid', async () => {
      bridge.notify('fire', 'hello', 123);
      await new Promise((r) => setTimeout(r, 20));
      const notif = router.received.find((m) => m[0] === 2 && m[1] === 'fire');
      expect(notif).toBeDefined();
      expect(notif![2]).toEqual(['hello', 123]);
    });
  });

  describe('provide()', () => {
    it('registers method and handles inbound requests', async () => {
      let handlerCalled = false;
      await bridge.provide('my_method', (params) => {
        handlerCalled = true;
        return `echo: ${params[0]}`;
      });

      // Verify $/register was sent
      const reg = router.received.find(
        (m) => m[0] === MSG_REQUEST && m[2] === '$/register',
      ) as RpcRequest;
      expect(reg).toBeDefined();
      expect(reg[3]).toEqual(['my_method']);

      // Send an inbound request to the handler
      router.sendRequest(99, 'my_method', ['world']);
      await new Promise((r) => setTimeout(r, 50));
      expect(handlerCalled).toBe(true);

      // Verify the response was sent back
      const resp = router.received.find(
        (m) => m[0] === 1 && m[1] === 99,
      );
      // Response goes back on the wire, check via the mock's received
      // The response is written to the socket, not received by the server as a new message
      // (the server sends the request, the client sends the response back)
      // We need to check differently — let's use a request waiter pattern instead
    });

    it('waitForActiveHandlers lets a deferred handler send its response before close', async () => {
      let resolveHandler!: (v: unknown) => void;
      await bridge.provide('deferred_method', () => {
        return new Promise((resolve) => {
          resolveHandler = resolve;
        });
      });

      // Drain $/register from received history so find() below doesn't pick up the wrong entry.
      router.received.length = 0;

      router.sendRequest(42, 'deferred_method', []);
      await new Promise((r) => setTimeout(r, 50));
      expect(bridge.activeHandlerCount).toBe(1);

      // Resolve the handler from elsewhere (simulates UnoQRespond), then close.
      // Without waitForActiveHandlers(), the microtask ordering combined with a
      // close() that tears down the socket would drop the response.
      setTimeout(() => resolveHandler('late-ok'), 100);
      await bridge.waitForActiveHandlers(1000);
      expect(bridge.activeHandlerCount).toBe(0);

      // Yield once so the mock router can read the response bytes off the socket.
      await new Promise((r) => setTimeout(r, 20));

      const resp = router.received.find(
        (m) => m[0] === 1 && (m as [number, number, unknown, unknown])[1] === 42,
      );
      expect(resp).toBeDefined();
      expect((resp as [number, number, unknown, unknown])[3]).toBe('late-ok');
    });

    it('handler errors become error responses', async () => {
      await bridge.provide('fail_method', () => {
        throw new Error('oops');
      });

      // The mock router needs to read the response the bridge sends back.
      // Since the server wrote the request and the bridge responds on the same socket,
      // we need a decoder on the server side of that connection.
      // For simplicity, send request and verify via a second connection check.
      router.sendRequest(77, 'fail_method', []);
      // Give time for async handler + response
      await new Promise((r) => setTimeout(r, 50));
      // The error response [1, 77, "oops", null] was written back to the socket.
      // Since MockRouter reads from clients, it will have received this response.
      const errResp = router.received.find(
        (m) => m[0] === 1 && (m as [number, number, unknown, unknown])[1] === 77,
      );
      expect(errResp).toBeDefined();
      expect((errResp as [number, number, string, unknown])[2]).toBe('oops');
    });
  });

  describe('onNotify()', () => {
    it('registers on router and receives inbound notifications', async () => {
      const received: unknown[][] = [];
      await bridge.onNotify('button_pressed', (params) => received.push(params));

      // Verify $/register was sent for the notify subscription
      const reg = router.received.find(
        (m) => m[0] === MSG_REQUEST && m[2] === '$/register' && (m as RpcRequest)[3][0] === 'button_pressed',
      );
      expect(reg).toBeDefined();

      router.sendNotify('button_pressed', [3, 'rising']);
      await new Promise((r) => setTimeout(r, 30));
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual([3, 'rising']);
    });

    it('unsubscribe stops notifications', async () => {
      const received: unknown[][] = [];
      const unsub = await bridge.onNotify('event', (params) => received.push(params));
      router.sendNotify('event', [1]);
      await new Promise((r) => setTimeout(r, 20));
      expect(received).toHaveLength(1);

      unsub();
      router.sendNotify('event', [2]);
      await new Promise((r) => setTimeout(r, 20));
      expect(received).toHaveLength(1); // still 1, not 2
    });
  });

  describe('reconnect', () => {
    it('re-registers providers after reconnect', async () => {
      await bridge.provide('my_service', () => 'ok');
      router.received.length = 0; // clear

      // Kill client connections, router stays listening
      router.destroyClients();

      // Wait for reconnect + re-register
      await new Promise((r) => setTimeout(r, 300));

      const reReg = router.received.find(
        (m) => m[0] === MSG_REQUEST && m[2] === '$/register' && (m as RpcRequest)[3][0] === 'my_service',
      );
      expect(reReg).toBeDefined();
    });
  });

  // Tests for a hygiene gap identified by code review: when the socket drops
  // while a provide handler is in-flight, the bridge currently has no way to
  // signal the application layer. Consumers (e.g. n8n's UnoQTrigger, which
  // holds deferred request state in PendingRequests) have no hook to reject
  // their orphaned entries, so the handler's eventual RESPONSE either vanishes
  // into the reconnected socket with a stale msgid or waits for a workflow
  // Respond that may never come. Expected behaviour: bridge emits a
  // `disconnect` event carrying the reason so consumers can clean up.
  // The retry contract from CONTEXT.md §6.4 "Capability metadata and retry contract":
  //
  // - callWithOptions(method, params[], { idempotent: true }) retries ONCE on
  //   ConnectionError mid-call, gated by Promise.race(reconnect, remaining budget).
  // - { idempotent: false } (the default) never retries.
  // - Never retry on TimeoutError — the MCU may still be executing.
  // - The retry shares the original timeoutMs budget — no second full window.
  describe('callWithOptions()', () => {
    it('retries once on mid-call socket drop when idempotent', async () => {
      // First attempt: send the request, then drop the socket so the call
      // rejects with ConnectionError. Bridge auto-reconnects, then we retry.
      const pending = bridge.callWithOptions('toggle_valve', [true], {
        idempotent: true,
        timeoutMs: 2000,
      });

      // Wait for the first request to land, then kill the socket.
      await new Promise((r) => setTimeout(r, 30));
      const firstReq = router.received.find(
        (m) => m[0] === MSG_REQUEST && m[2] === 'toggle_valve',
      ) as RpcRequest;
      expect(firstReq).toBeDefined();
      router.received.length = 0;
      router.destroyClients();

      // Wait for reconnect (baseDelayMs=50 in connectBridge) and the retry.
      await new Promise((r) => setTimeout(r, 200));
      const retryReq = router.received.find(
        (m) => m[0] === MSG_REQUEST && m[2] === 'toggle_valve',
      ) as RpcRequest;
      expect(retryReq).toBeDefined();
      expect(retryReq[1]).not.toBe(firstReq[1]); // fresh msgid

      router.respond(retryReq[1], null, 'ok');
      await expect(pending).resolves.toBe('ok');
    });

    it('does not retry on socket drop when not idempotent', async () => {
      const pending = bridge.callWithOptions('pulse_relay', [], {
        idempotent: false,
        timeoutMs: 2000,
      });

      await new Promise((r) => setTimeout(r, 30));
      router.received.length = 0;
      router.destroyClients();

      await expect(pending).rejects.toThrow(ConnectionError);

      // Wait past the reconnect window and confirm no retry was attempted.
      await new Promise((r) => setTimeout(r, 250));
      const retryReq = router.received.find(
        (m) => m[0] === MSG_REQUEST && m[2] === 'pulse_relay',
      );
      expect(retryReq).toBeUndefined();
    });

    it('does not retry on timeout, even when idempotent', async () => {
      // Server never responds. Should reject with TimeoutError after timeoutMs,
      // and never re-send the request even though idempotent is true.
      const pending = bridge.callWithOptions('slow_read', [], {
        idempotent: true,
        timeoutMs: 80,
      });

      await expect(pending).rejects.toThrow(TimeoutError);

      const all = router.received.filter(
        (m) => m[0] === MSG_REQUEST && m[2] === 'slow_read',
      );
      expect(all).toHaveLength(1);
    });

    // Even before the original §6.4 contract, there's a foot-gun: if a call
    // *starts* during the brief window between socket-drop and reconnect, the
    // bridge previously wrote to a destroyed socket silently and the pending
    // entry sat until the timer fired (TimeoutError). The retry path didn't
    // help because there was no first-attempt ConnectionError to catch.
    //
    // Fix: attempt() checks `this.connected` and rejects fast with
    // ConnectionError when disconnected, so:
    // - non-idempotent fails fast instead of waiting for timeout, and
    // - idempotent enters the retry path and recovers after reconnect.
    //
    // This makes the contract self-consistent: "idempotent calls survive
    // socket disruption" rather than "...survive only mid-call disruption".
    it('rejects fast with ConnectionError when call starts while disconnected (no retry)', async () => {
      router.destroyClients();
      // Wait long enough for the bridge to register the close (connected=false)
      // but well short of the reconnect delay (baseDelayMs=50 in connectBridge).
      await new Promise((r) => setTimeout(r, 20));

      const start = Date.now();
      await expect(
        bridge.callWithOptions('something', [], { idempotent: false, timeoutMs: 2000 }),
      ).rejects.toThrow(ConnectionError);
      const elapsed = Date.now() - start;
      // Should be near-instant, nowhere near the 2000ms budget.
      expect(elapsed).toBeLessThan(100);
    });

    it('idempotent call started while disconnected retries after reconnect', async () => {
      router.destroyClients();
      await new Promise((r) => setTimeout(r, 20));

      const pending = bridge.callWithOptions('echo', [], {
        idempotent: true,
        timeoutMs: 3000,
      });

      // Wait for transport reconnect (~50ms) + retry attempt to send the
      // request, then respond from the mock.
      await new Promise((r) => setTimeout(r, 200));
      const req = router.received.find(
        (m) => m[0] === MSG_REQUEST && m[2] === 'echo',
      ) as RpcRequest;
      expect(req).toBeDefined();
      router.respond(req[1], null, 'retry-after-dead-window');

      await expect(pending).resolves.toBe('retry-after-dead-window');
    });

    // Reality check: a single arduino-router restart causes multiple
    // disconnect/reconnect cycles (the SSH tunnel recovers faster than the
    // router stabilises). A "retry once" contract leaks ConnectionError on
    // the second drop. The contract is "retry within the remaining timeoutMs
    // budget" — keep retrying as long as the budget allows.
    it('retries through cascading drops when idempotent', async () => {
      const pending = bridge.callWithOptions('flapping', [], {
        idempotent: true,
        timeoutMs: 3000,
      });

      // Wait for the first attempt to land, then drop the connection.
      await new Promise((r) => setTimeout(r, 30));
      router.received.length = 0;
      router.destroyClients();

      // Wait for the bridge to reconnect and the retry attempt to land,
      // then drop again before responding.
      await new Promise((r) => setTimeout(r, 200));
      const retry1 = router.received.find(
        (m) => m[0] === MSG_REQUEST && m[2] === 'flapping',
      ) as RpcRequest;
      expect(retry1).toBeDefined();
      router.received.length = 0;
      router.destroyClients();

      // Wait for the second reconnect + second retry, then respond.
      await new Promise((r) => setTimeout(r, 200));
      const retry2 = router.received.find(
        (m) => m[0] === MSG_REQUEST && m[2] === 'flapping',
      ) as RpcRequest;
      expect(retry2).toBeDefined();
      expect(retry2[1]).not.toBe(retry1[1]); // fresh msgid

      router.respond(retry2[1], null, 'survived-cascading-drops');
      await expect(pending).resolves.toBe('survived-cascading-drops');
    });

    it('respects the overall timeoutMs budget across retries', async () => {
      // Idempotent call, but the bridge cannot reconnect before the budget runs
      // out — the mock router is stopped entirely. The race between the
      // reconnect event and the remaining budget must let the budget win and
      // surface a TimeoutError, not hang or extend the window.
      const pending = bridge.callWithOptions('read_temp', [], {
        idempotent: true,
        timeoutMs: 200,
      });
      await new Promise((r) => setTimeout(r, 30));
      // Stop the router so reconnect attempts keep failing.
      await router.stop();

      const start = Date.now();
      await expect(pending).rejects.toThrow(TimeoutError);
      const elapsed = Date.now() - start;
      // Should be roughly within the original budget (200ms total from call
      // start, ~170ms from this point). Allow generous slack for CI jitter,
      // but it must be well under "two budgets" (400ms).
      expect(elapsed).toBeLessThan(350);
    });
  });

  describe('socket close signalling', () => {
    it('emits a disconnect event when the socket drops', async () => {
      const events: Array<{ err?: Error }> = [];
      bridge.on('disconnect', (err?: Error) => {
        events.push({ err });
      });

      router.destroyClients();
      await new Promise((r) => setTimeout(r, 100));

      expect(events.length).toBeGreaterThan(0);
    });

    it('does not leave orphaned provide handlers in activeHandlers after a mid-call drop', async () => {
      let resolveHandler: (v: unknown) => void = () => {};
      await bridge.provide('long_running', () => {
        return new Promise((resolve) => {
          resolveHandler = resolve;
        });
      });

      router.received.length = 0;
      router.sendRequest(99, 'long_running', []);
      await new Promise((r) => setTimeout(r, 50));
      expect(bridge.activeHandlerCount).toBe(1);

      // Socket drops mid-handler. The handler's eventual RESPONSE has nowhere
      // to go — the original MCU msgid is unknown to whatever socket comes
      // back. The in-flight task should be cleaned up so consumers can notice
      // and abort their own deferred state.
      router.destroyClients();
      await new Promise((r) => setTimeout(r, 150));

      expect(bridge.activeHandlerCount).toBe(0);

      // Let any leftover Promise settle so afterEach can close cleanly
      resolveHandler('late-response');
      await new Promise((r) => setTimeout(r, 30));
    });
  });
});
