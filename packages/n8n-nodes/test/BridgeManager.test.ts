/**
 * BridgeManager tests — covers the hygiene gap identified by code review.
 *
 * When a trigger deactivates, BridgeManager.release() sets `this.bridge = null`
 * synchronously but schedules the actual socket close as a fire-and-forget
 * background task (waitForActiveHandlers up to 60s, then close). If an
 * acquire() fires inside that window it opens a *fresh* connection while the
 * old one is still alive — a real arduino-router would reject $/register
 * calls from the new connection for methods still owned by the old one.
 *
 * This test reproduces the race by observing active connections on a local
 * mock router that mimics the real router's transport shape (no registration
 * enforcement needed — the observable symptom is two open connections).
 */
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { BridgeManager } from '../src/BridgeManager.js';

/**
 * Minimal msgpack-rpc-ish mock router. We only need enough to let the bridge
 * connect and auto-ack $/register calls so the test scenario can drive state.
 * Deliberately lean — factored copies of packages/bridge/test's MockRouter can
 * live in a shared helpers package later.
 */
class MockRouter {
  readonly socketPath: string;
  private server: net.Server;
  clients: net.Socket[] = [];

  constructor() {
    this.socketPath = path.join(os.tmpdir(), `mgr-test-${crypto.randomUUID()}.sock`);
    this.server = net.createServer((socket) => this.onClient(socket));
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  private onClient(socket: net.Socket): void {
    this.clients.push(socket);

    // Auto-ack every $/register by scanning incoming bytes for the string
    // "$/register" and writing back a success response for each. This is
    // crude but sufficient: the bridge only needs SOME response to unblock
    // its own provide() Promises, and we don't assert on call semantics here.
    socket.on('data', (chunk: Buffer) => {
      if (chunk.includes(Buffer.from('$/register'))) {
        // Respond success: [1, msgid, null, true] — msgid is the second byte
        // after the 0x94 array-of-4 marker in the incoming REQUEST. We don't
        // decode properly; the bridge tolerates ack noise as long as msgids
        // line up, and our tests don't depend on the return value.
        // Cheap hack: respond to msgid = chunk[2] (close enough for the shape
        // msgpack typically produces for small ints).
        const msgid = chunk[2];
        const response = Buffer.from([0x94, 0x01, msgid, 0xc0, 0xc3]); // [1, msgid, null, true]
        socket.write(response);
      }
    });

    socket.on('close', () => {
      this.clients = this.clients.filter((c) => c !== socket);
    });

    socket.on('error', () => {
      /* ignore */
    });
  }

  /** Send a REQUEST to the most recent client (triggers a provide handler). */
  sendRequest(msgid: number, method: string): void {
    const socket = this.clients[this.clients.length - 1];
    if (!socket) return;
    // [0, msgid, method, []] — minimal hand-crafted msgpack for this shape
    const methodBytes = Buffer.from(method, 'utf-8');
    const msg = Buffer.concat([
      Buffer.from([0x94, 0x00, msgid]), // array(4), 0, msgid (small int)
      Buffer.from([0xa0 | methodBytes.length]), // fixstr marker
      methodBytes,
      Buffer.from([0x90]), // empty array
    ]);
    socket.write(msg);
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

describe('BridgeManager acquire() refCount hygiene', () => {
  it('does not leak refCount when Bridge.connect throws', async () => {
    // A failed connect (TLS handshake blip, socket missing, etc.) used to pin
    // the entry alive forever because acquire() bumped refCount before the
    // await and never rolled it back on failure. Over time this made the
    // bridge non-closeable, which is the precondition for "route already
    // exists" errors on subsequent trigger re-arms.
    const manager = new BridgeManager();
    const descriptor = {
      kind: 'unix' as const,
      path: path.join(os.tmpdir(), `nonexistent-${crypto.randomUUID()}.sock`),
    };

    await expect(manager.acquire(descriptor)).rejects.toThrow();

    // Snapshot should either be undefined (entry dropped) or show refCount=0.
    const snap = manager.snapshot(descriptor);
    if (snap) {
      expect(snap.refCount).toBe(0);
      expect(snap.bridgeOpen).toBe(false);
    }

    // A subsequent successful acquire against a live socket must start from a
    // clean state — refCount must be 1, not 2 (which would indicate the
    // previous failed attempt leaked a slot).
    const router = new MockRouter();
    await router.start();
    try {
      const liveDescriptor = { kind: 'unix' as const, path: router.socketPath };
      const bridge = await manager.acquire(liveDescriptor);
      bridge.on('error', () => {});
      const liveSnap = manager.snapshot(liveDescriptor);
      expect(liveSnap?.refCount).toBe(1);
      await manager.release(liveDescriptor);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await router.stop();
    }
  });
});

describe('BridgeManager close race', () => {
  it('does not leave the previous bridge connected to the router after acquire+release churn', async () => {
    const router = new MockRouter();
    await router.start();

    try {
      const manager = new BridgeManager();
      const descriptor = { kind: 'unix' as const, path: router.socketPath };

      const bridgeA = await manager.acquire(descriptor);
      bridgeA.on('error', () => {}); // suppress unhandled-error noise

      // Install a provide handler that resolves after ~300ms — models a real
      // UnoQRespond firing shortly after the user deactivates the workflow.
      // This keeps activeHandlers populated long enough to hold the old
      // bridge open during the release→acquire window, then drains cleanly
      // so the fix (which awaits previous close in acquire) can complete.
      let resolveStuck: (v: unknown) => void = () => {};
      await bridgeA.provide('stuck', () => {
        return new Promise((resolve) => {
          resolveStuck = resolve;
        });
      });

      router.sendRequest(5, 'stuck');
      await new Promise((r) => setTimeout(r, 50));
      expect(bridgeA.activeHandlerCount).toBe(1);

      // Schedule handler resolution. Without the fix, acquire(B) returns
      // immediately and both sockets are observed as live. With the fix,
      // acquire(B) awaits the tracked close — which completes ~300ms later
      // when the handler resolves and the socket teardown finishes.
      setTimeout(() => resolveStuck('done'), 300);

      // Release starts the background close.
      await manager.release(descriptor);

      // Acquire a new bridge. Before the fix: returns instantly with a fresh
      // connection while the old one is still open → 2 sockets on the router.
      // After the fix: blocks until pendingClose resolves → only B's socket.
      const bridgeB = await manager.acquire(descriptor);
      bridgeB.on('error', () => {});

      expect(router.clients.length).toBe(1);

      // Cleanup: release B so the connection doesn't leak past the test
      await manager.release(descriptor);
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      await router.stop();
    }
  }, 10_000);
});
