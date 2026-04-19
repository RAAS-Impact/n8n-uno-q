/**
 * Process-singleton that holds open MessagePack-RPC requests received by the
 * UnoQTrigger in Request / Wait-for-Respond mode.
 *
 * Keyed by the router-assigned msgid. The Trigger inserts an entry when a
 * Bridge.provide() handler fires and returns a deferred Promise; the future
 * UnoQRespond node will take() the entry and resolve or reject it.
 *
 * Like BridgeManager, stashed on globalThis because each n8n node is bundled
 * as an independent CJS file — module-level state would not be shared.
 */
const SINGLETON_KEY = Symbol.for('@raasimpact/arduino-uno-q/pending-requests');

export interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PendingRequests {
  private entries = new Map<number, PendingEntry>();

  static getInstance(): PendingRequests {
    const g = globalThis as unknown as Record<symbol, PendingRequests | undefined>;
    if (!g[SINGLETON_KEY]) {
      g[SINGLETON_KEY] = new PendingRequests();
    }
    return g[SINGLETON_KEY]!;
  }

  register(msgid: number, entry: PendingEntry): void {
    this.entries.set(msgid, entry);
  }

  /** Atomically remove and return the entry. Subsequent take() for the same msgid returns undefined. */
  take(msgid: number): PendingEntry | undefined {
    const entry = this.entries.get(msgid);
    if (entry) this.entries.delete(msgid);
    return entry;
  }

  has(msgid: number): boolean {
    return this.entries.has(msgid);
  }

  size(): number {
    return this.entries.size;
  }
}
