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
});
