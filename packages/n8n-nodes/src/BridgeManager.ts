import { Bridge } from '@raasimpact/arduino-uno-q-bridge';

/**
 * Process-singleton that manages a shared Bridge instance.
 * Ensures only one socket connection per n8n process and ref-counts
 * method registrations so multiple trigger nodes can share a method.
 */
/**
 * Each node file is bundled independently by esbuild, so module-level state
 * is per-bundle. To keep a true process-wide singleton across all n8n nodes,
 * we stash the instance on globalThis under a unique Symbol.for key.
 */
const SINGLETON_KEY = Symbol.for('@raasimpact/arduino-uno-q/bridge-manager');

export class BridgeManager {
  private bridge: Bridge | null = null;
  private refCount = 0;
  private methodRefs = new Map<string, number>();
  /**
   * Tracks the in-progress background close scheduled by a prior release().
   * acquire() and getBridge() await this before opening a fresh socket —
   * otherwise a rapid release→acquire cycle (e.g. deactivate then immediately
   * reactivate a workflow) leaves two sockets live on the router briefly, and
   * the router rejects the new $/register calls for methods still owned by
   * the old connection.
   */
  private pendingClose: Promise<void> | null = null;

  static getInstance(): BridgeManager {
    const g = globalThis as unknown as Record<symbol, BridgeManager | undefined>;
    if (!g[SINGLETON_KEY]) {
      g[SINGLETON_KEY] = new BridgeManager();
    }
    return g[SINGLETON_KEY]!;
  }

  async acquire(socketPath?: string): Promise<Bridge> {
    if (this.pendingClose) {
      await this.pendingClose;
    }
    this.refCount++;
    if (!this.bridge) {
      this.bridge = await Bridge.connect({ socket: socketPath });
    }
    return this.bridge;
  }

  /**
   * Get (or lazily create) the shared Bridge without touching the refcount.
   * Intended for short-lived users like the Call node: they don't own a
   * subscription, so they must not participate in the acquire/release
   * lifecycle that triggers use to decide when to close the socket.
   */
  async getBridge(socketPath?: string): Promise<Bridge> {
    if (this.pendingClose) {
      await this.pendingClose;
    }
    if (!this.bridge) {
      this.bridge = await Bridge.connect({ socket: socketPath });
    }
    return this.bridge;
  }

  async release(): Promise<void> {
    this.refCount--;
    if (this.refCount <= 0 && this.bridge) {
      const oldBridge = this.bridge;
      this.bridge = null;
      this.refCount = 0;
      // Fire-and-forget: in-flight provide handlers (e.g. UnoQTrigger deferred →
      // UnoQRespond) must finish writing their RESPONSE before the socket closes,
      // but we MUST NOT block the caller. n8n's "Listen for test event" awaits
      // closeFunction on the same execution path that later needs to run the
      // downstream UnoQRespond — blocking here deadlocks the workflow: Respond
      // never runs, handler never resolves, drain never returns.
      //
      // Subsequent acquire()/getBridge() await pendingClose so new connections
      // wait for the old one to finish tearing down.
      const closePromise = oldBridge
        .waitForActiveHandlers(60_000)
        .catch(() => {})
        .then(() => oldBridge.close())
        .catch(() => {});
      this.pendingClose = closePromise;
      void closePromise.finally(() => {
        if (this.pendingClose === closePromise) {
          this.pendingClose = null;
        }
      });
    }
  }

  /** Increment ref for a method registration. Returns true if this is the first subscriber. */
  addMethodRef(method: string): boolean {
    const current = this.methodRefs.get(method) ?? 0;
    this.methodRefs.set(method, current + 1);
    return current === 0;
  }

  /** Decrement ref for a method registration. Returns true if this was the last subscriber. */
  removeMethodRef(method: string): boolean {
    const current = this.methodRefs.get(method) ?? 0;
    if (current <= 1) {
      this.methodRefs.delete(method);
      return true;
    }
    this.methodRefs.set(method, current - 1);
    return false;
  }
}
