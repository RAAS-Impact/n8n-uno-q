/**
 * Process-wide singleton managing realtime MQTT-over-WSS connections to
 * Arduino Cloud — one `CloudClient` per credential, shared across every
 * ArduinoCloudTrigger node that uses that credential.
 *
 * Why this exists. `arduino-iot-js` exposes `onPropertyValue(thingId, name,
 * callback)` but gives no per-subscription unsubscribe handle; the only
 * tear-down is `disconnect()` on the whole client. That's fine when one node
 * owns one connection, but as soon as two triggers point at the same Thing
 * on the same credential, a naive "one client per node" model pays double
 * the auth cost, the double the MQTT traffic, and breaks on the first
 * credential rate-limit bump.
 *
 * So: one client per credential, a refcounted subscription table per
 * (thingId, variableName), and a demux layer that routes a single SDK
 * subscription to every trigger node listening for the same value. The SDK
 * subscription is never torn down until the entire client is released —
 * even if no handlers are left for a key, the worst case is a handful of
 * ignored messages until the client disconnects.
 *
 * State lives on globalThis because each node bundle has its own copy of
 * this file after esbuild, same pattern as BridgeManager in n8n-nodes-uno-q.
 */
import { ArduinoIoTCloud, ArduinoIoTCloudFactory } from 'arduino-iot-js';
import mqtt from 'mqtt';

// The CloudClient class is not exported from the package root — only the
// singleton instance and the factory. We borrow the type from the singleton
// binding so the manager tracks real CloudClient instances without reaching
// into the package's internal paths.
type CloudClient = typeof ArduinoIoTCloud;

const SINGLETON_KEY = Symbol.for('@raasimpact/arduino-cloud/cloud-client-manager');

export interface CloudCredential {
  clientId: string;
  clientSecret: string;
  organizationId?: string;
}

export type PropertyValueHandler = (value: unknown) => void;

interface ClientEntry {
  client: CloudClient | null;
  /** Resolves to the connected client; shared across concurrent acquire calls. */
  pendingConnect: Promise<CloudClient> | null;
  /** Per (thingId, variableName) set of handlers. */
  handlers: Map<string, Set<PropertyValueHandler>>;
  /** Keys for which we've already called the SDK's `onPropertyValue`. */
  sdkSubscribed: Set<string>;
  /** Total subscription refcount — disconnect when it drops to zero. */
  refCount: number;
}

function subKey(thingId: string, variableName: string): string {
  return `${thingId}\0${variableName}`;
}

export class CloudClientManager {
  private entries = new Map<string, ClientEntry>();

  static getInstance(): CloudClientManager {
    const g = globalThis as unknown as Record<symbol, CloudClientManager | undefined>;
    if (!g[SINGLETON_KEY]) {
      g[SINGLETON_KEY] = new CloudClientManager();
    }
    return g[SINGLETON_KEY]!;
  }

  private getEntry(credentialKey: string): ClientEntry {
    let entry = this.entries.get(credentialKey);
    if (!entry) {
      entry = {
        client: null,
        pendingConnect: null,
        handlers: new Map(),
        sdkSubscribed: new Set(),
        refCount: 0,
      };
      this.entries.set(credentialKey, entry);
    }
    return entry;
  }

  /**
   * Subscribe to property-value events for a specific (thingId, variableName)
   * pair on the given credential. Returns an async tear-down that decrements
   * the refcount and, when it reaches zero for the credential, disconnects
   * the shared client.
   */
  async subscribe(
    credentialKey: string,
    credential: CloudCredential,
    thingId: string,
    variableName: string,
    handler: PropertyValueHandler,
  ): Promise<() => Promise<void>> {
    const entry = this.getEntry(credentialKey);
    entry.refCount++;

    let client: CloudClient;
    try {
      client = await this.ensureConnected(entry, credential);
    } catch (err) {
      entry.refCount--;
      throw err;
    }

    const key = subKey(thingId, variableName);
    let set = entry.handlers.get(key);
    if (!set) {
      set = new Set();
      entry.handlers.set(key, set);
    }
    set.add(handler);

    // Subscribe at the SDK level only once per (thingId, variableName). Every
    // additional handler just joins the demux set above. We never unsubscribe
    // at the SDK level; `disconnect()` below tears everything down when the
    // last trigger releases the client.
    if (!entry.sdkSubscribed.has(key)) {
      entry.sdkSubscribed.add(key);
      try {
        await client.onPropertyValue(thingId, variableName, (value: unknown) => {
          const handlers = entry.handlers.get(key);
          if (!handlers) return;
          for (const fn of handlers) {
            try {
              fn(value);
            } catch (err) {
              // One handler crashing shouldn't poison the rest. Log and move
              // on — the trigger owner gets to see it in their own try/catch
              // if the handler throws synchronously.
              // eslint-disable-next-line no-console
              console.error('[arduino-cloud] property-value handler threw:', err);
            }
          }
        });
      } catch (err) {
        entry.sdkSubscribed.delete(key);
        set.delete(handler);
        if (set.size === 0) entry.handlers.delete(key);
        entry.refCount--;
        if (entry.refCount === 0) await this.teardown(credentialKey, entry);
        throw err;
      }
    }

    return async () => {
      const handlers = entry.handlers.get(key);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) entry.handlers.delete(key);
      }
      entry.refCount--;
      if (entry.refCount === 0) await this.teardown(credentialKey, entry);
    };
  }

  private async ensureConnected(
    entry: ClientEntry,
    credential: CloudCredential,
  ): Promise<CloudClient> {
    if (entry.client) return entry.client;
    if (entry.pendingConnect) return entry.pendingConnect;

    entry.pendingConnect = (async () => {
      // Cast: `mqtt.connect` is overloaded `(url, opts?) | (opts)` but the
      // SDK's `MqttConnect` type only accepts the `(url, opts) => MqttClient`
      // shape. At runtime the SDK calls it exactly that way (see index.js in
      // arduino-iot-js — `x=_(c.default.connect)`), so the cast is safe.
      const client = ArduinoIoTCloudFactory(mqtt.connect as Parameters<typeof ArduinoIoTCloudFactory>[0]);
      await client.connect({
        clientId: credential.clientId,
        clientSecret: credential.clientSecret,
      });
      entry.client = client;
      return client;
    })();

    try {
      return await entry.pendingConnect;
    } finally {
      entry.pendingConnect = null;
    }
  }

  private async teardown(credentialKey: string, entry: ClientEntry): Promise<void> {
    const client = entry.client;
    entry.client = null;
    entry.handlers.clear();
    entry.sdkSubscribed.clear();
    this.entries.delete(credentialKey);
    if (client) {
      try {
        await client.disconnect();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[arduino-cloud] client disconnect failed:', err);
      }
    }
  }

  /** Test-only: forget all state (does not disconnect; tests use mocks). */
  __resetForTests(): void {
    this.entries.clear();
  }
}
