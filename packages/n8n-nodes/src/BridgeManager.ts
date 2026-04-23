import { Bridge, describeTransport } from '@raasimpact/arduino-uno-q-bridge';
import type { TransportDescriptor } from '@raasimpact/arduino-uno-q-bridge';

/**
 * Process-singleton that manages shared Bridge instances — one per router
 * endpoint. Keyed by the canonical transport descriptor (e.g.
 * `unix:/var/run/arduino-router.sock` or `tcp:192.168.1.10:5775`), so a
 * workflow driving two Qs with two different credentials gets two separate
 * Bridge instances, each with its own refcount and subscription table.
 *
 * Each node file is bundled independently by esbuild, so module-level state
 * is per-bundle. To keep a true process-wide singleton across all n8n nodes,
 * we stash the instance on globalThis under a unique Symbol.for key.
 */
const SINGLETON_KEY = Symbol.for('@raasimpact/arduino-uno-q/bridge-manager');

// Activate with DEBUG=bridge (shares the env var with the bridge package).
const DEBUG = process.env.DEBUG?.includes('bridge') ?? false;
function debug(category: string, ...args: unknown[]) {
  if (DEBUG) console.debug(`[bridge-manager:${category}]`, ...args);
}

interface BridgeEntry {
  bridge: Bridge | null;
  refCount: number;
  methodRefs: Map<string, number>;
  /**
   * Tracks the in-progress background close scheduled by a prior release().
   * acquire()/getBridge() for the same descriptor await this before opening a
   * fresh socket — otherwise a rapid release→acquire cycle (e.g. deactivate
   * then immediately reactivate a workflow) leaves two sockets live on the
   * router briefly, and the router rejects the new $/register calls for
   * methods still owned by the old connection.
   */
  pendingClose: Promise<void> | null;
  descriptor: TransportDescriptor;
}

export class BridgeManager {
  private entries = new Map<string, BridgeEntry>();

  static getInstance(): BridgeManager {
    const g = globalThis as unknown as Record<symbol, BridgeManager | undefined>;
    if (!g[SINGLETON_KEY]) {
      g[SINGLETON_KEY] = new BridgeManager();
    }
    return g[SINGLETON_KEY]!;
  }

  private getEntry(descriptor: TransportDescriptor): BridgeEntry {
    const key = describeTransport(descriptor);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        bridge: null,
        refCount: 0,
        methodRefs: new Map(),
        pendingClose: null,
        descriptor,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  async acquire(descriptor: TransportDescriptor): Promise<Bridge> {
    const key = describeTransport(descriptor);
    const entry = this.getEntry(descriptor);
    if (entry.pendingClose) {
      debug('acquire', key, 'awaiting pendingClose');
      await entry.pendingClose;
    }
    // Bump refCount BEFORE Bridge.connect so a concurrent acquire() sees us
    // as an owner and doesn't race to open a second socket. If connect
    // throws, we must undo the increment — otherwise failed connects (TLS
    // handshake hiccups, transient network) pin the entry alive forever,
    // which is what originally surfaced as "route already exists" in prod.
    entry.refCount++;
    const opened = !entry.bridge;
    if (!entry.bridge) {
      try {
        entry.bridge = await Bridge.connect({ transport: descriptor });
      } catch (err) {
        entry.refCount--;
        debug('acquire:connect-failed', key, `refCount=${entry.refCount}`, (err as Error).message);
        if (entry.refCount === 0 && entry.methodRefs.size === 0 && entry.pendingClose === null) {
          this.entries.delete(key);
        }
        throw err;
      }
    }
    debug('acquire', key, `refCount=${entry.refCount}`, opened ? 'opened new bridge' : 'reused bridge');
    return entry.bridge;
  }

  /**
   * Get (or lazily create) the shared Bridge for this descriptor without
   * touching the refcount. Intended for short-lived users like the Call/Tool
   * nodes: they don't own a subscription, so they must not participate in the
   * acquire/release lifecycle that triggers use to decide when to close the
   * socket.
   */
  async getBridge(descriptor: TransportDescriptor): Promise<Bridge> {
    const key = describeTransport(descriptor);
    const entry = this.getEntry(descriptor);
    if (entry.pendingClose) {
      debug('getBridge', key, 'awaiting pendingClose');
      await entry.pendingClose;
    }
    const opened = !entry.bridge;
    if (!entry.bridge) {
      entry.bridge = await Bridge.connect({ transport: descriptor });
    }
    if (opened) debug('getBridge', key, 'opened new bridge (no refcount change)');
    return entry.bridge;
  }

  async release(descriptor: TransportDescriptor): Promise<void> {
    const key = describeTransport(descriptor);
    const entry = this.entries.get(key);
    if (!entry) {
      debug('release', key, 'no entry — noop');
      return;
    }
    entry.refCount--;
    debug('release', key, `refCount=${entry.refCount}`);
    if (entry.refCount <= 0 && entry.bridge) {
      const oldBridge = entry.bridge;
      entry.bridge = null;
      entry.refCount = 0;
      // Fire-and-forget: in-flight provide handlers (e.g. UnoQTrigger deferred →
      // UnoQRespond) must finish writing their RESPONSE before the socket closes,
      // but we MUST NOT block the caller. n8n's "Listen for test event" awaits
      // closeFunction on the same execution path that later needs to run the
      // downstream UnoQRespond — blocking here deadlocks the workflow: Respond
      // never runs, handler never resolves, drain never returns.
      //
      // Subsequent acquire()/getBridge() for the same descriptor await
      // pendingClose so new connections wait for the old one to finish tearing
      // down.
      debug(
        'release:close-start',
        key,
        `activeHandlers=${oldBridge.activeHandlerCount}`,
        `methods=${JSON.stringify(Object.fromEntries(entry.methodRefs))}`,
      );
      const closePromise = oldBridge
        .waitForActiveHandlers(60_000)
        .catch((err) => {
          debug('release:drain-error', key, (err as Error).message);
        })
        .then(() => oldBridge.close())
        .catch((err) => {
          debug('release:close-error', key, (err as Error).message);
        });
      entry.pendingClose = closePromise;
      void closePromise.finally(() => {
        debug('release:close-done', key);
        if (entry.pendingClose === closePromise) {
          entry.pendingClose = null;
        }
        // Drop the entry entirely if nothing is keeping it alive. Keeps the
        // Map from growing unboundedly when users churn through many
        // credentials during an editing session.
        if (
          entry.refCount === 0 &&
          !entry.bridge &&
          entry.methodRefs.size === 0 &&
          entry.pendingClose === null
        ) {
          this.entries.delete(key);
          debug('release:entry-deleted', key);
        }
      });
    }
  }

  /** Increment ref for a method registration. Returns true if this is the first subscriber. */
  addMethodRef(descriptor: TransportDescriptor, method: string): boolean {
    const key = describeTransport(descriptor);
    const entry = this.getEntry(descriptor);
    const current = entry.methodRefs.get(method) ?? 0;
    entry.methodRefs.set(method, current + 1);
    debug('addMethodRef', key, method, `${current}→${current + 1}`, current === 0 ? '(first)' : '');
    return current === 0;
  }

  /** Decrement ref for a method registration. Returns true if this was the last subscriber. */
  removeMethodRef(descriptor: TransportDescriptor, method: string): boolean {
    const key = describeTransport(descriptor);
    const entry = this.getEntry(descriptor);
    const current = entry.methodRefs.get(method) ?? 0;
    if (current <= 1) {
      entry.methodRefs.delete(method);
      debug('removeMethodRef', key, method, `${current}→0`, '(last)');
      return true;
    }
    entry.methodRefs.set(method, current - 1);
    debug('removeMethodRef', key, method, `${current}→${current - 1}`);
    return false;
  }

  /**
   * Diagnostic snapshot of the per-descriptor entry. Used by the catch paths of
   * the node implementations to dump state when a provide() / onNotify() call
   * fails, so divergence between BridgeManager bookkeeping and actual router
   * registrations is visible in the logs.
   */
  snapshot(descriptor: TransportDescriptor):
    | {
        key: string;
        refCount: number;
        methods: Record<string, number>;
        pendingClose: boolean;
        bridgeOpen: boolean;
      }
    | undefined {
    const key = describeTransport(descriptor);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return {
      key,
      refCount: entry.refCount,
      methods: Object.fromEntries(entry.methodRefs),
      pendingClose: entry.pendingClose !== null,
      bridgeOpen: entry.bridge !== null,
    };
  }
}
