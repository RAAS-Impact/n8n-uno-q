import { Bridge } from '@raasimpact/arduino-uno-q-bridge';

/**
 * Process-singleton that manages a shared Bridge instance.
 * Ensures only one socket connection per n8n process and ref-counts
 * method registrations so multiple trigger nodes can share a method.
 */
export class BridgeManager {
  private static instance: BridgeManager | null = null;
  private bridge: Bridge | null = null;
  private refCount = 0;
  private methodRefs = new Map<string, number>();

  static getInstance(): BridgeManager {
    if (!BridgeManager.instance) {
      BridgeManager.instance = new BridgeManager();
    }
    return BridgeManager.instance;
  }

  async acquire(socketPath?: string): Promise<Bridge> {
    this.refCount++;
    if (!this.bridge) {
      this.bridge = await Bridge.connect({ socket: socketPath });
    }
    return this.bridge;
  }

  async release(): Promise<void> {
    this.refCount--;
    if (this.refCount <= 0 && this.bridge) {
      await this.bridge.close();
      this.bridge = null;
      this.refCount = 0;
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
