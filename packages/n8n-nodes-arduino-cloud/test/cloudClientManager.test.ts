/**
 * CloudClientManager — invariant tests.
 *
 * The manager exists to enforce four properties that are easy to break and
 * impossible to confirm by reading the code in isolation:
 *
 *   1. Connection sharing across triggers on the same credential — one
 *      MQTT-over-WS client per credential, no matter how many subscriptions.
 *   2. SDK subscription deduplication — the underlying SDK call
 *      `onPropertyValue(thingId, variableName, ...)` happens exactly once
 *      per (thingId, variableName), even when many trigger nodes listen.
 *   3. Refcount → teardown — disconnect() runs only when the last handler
 *      across all subscriptions on a credential is released, not before.
 *   4. Failure paths don't leak refcount — a connect or subscribe that
 *      throws must restore the refcount, otherwise the client is pinned
 *      forever and never disconnects.
 *
 * The factory and mqtt module are mocked so a fake CloudClient can verify
 * the calls; the focus is the manager's bookkeeping, not the SDK's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeClient {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onPropertyValue: ReturnType<typeof vi.fn>;
  // Per (thingId, variableName) — the handler the SDK was registered with.
  // Tests pull these to simulate property updates from the broker.
  registered: Map<string, (value: unknown) => void>;
}

const builtClients: FakeClient[] = [];
let factoryShouldThrow: Error | null = null;
let onPropertyValueShouldThrow: Error | null = null;

function makeFakeClient(): FakeClient {
  const registered = new Map<string, (value: unknown) => void>();
  const client: FakeClient = {
    connect: vi.fn(async () => {
      if (factoryShouldThrow) throw factoryShouldThrow;
    }),
    disconnect: vi.fn(async () => {}),
    onPropertyValue: vi.fn(async (thingId: string, name: string, cb: (v: unknown) => void) => {
      if (onPropertyValueShouldThrow) throw onPropertyValueShouldThrow;
      registered.set(`${thingId}\0${name}`, cb);
    }),
    registered,
  };
  return client;
}

vi.mock('arduino-iot-js', () => ({
  ArduinoIoTCloud: {} as object,
  ArduinoIoTCloudFactory: vi.fn(() => {
    const c = makeFakeClient();
    builtClients.push(c);
    return c;
  }),
}));

vi.mock('mqtt', () => ({ default: { connect: vi.fn() } }));

import { CloudClientManager, type CloudCredential } from '../src/cloudClientManager.js';

const credA: CloudCredential = { clientId: 'A', clientSecret: 'sa' };
const credB: CloudCredential = { clientId: 'B', clientSecret: 'sb' };

function freshManager(): CloudClientManager {
  // Force a brand-new manager instance for each test — bypass the
  // globalThis cache so state doesn't bleed between tests.
  const SINGLETON_KEY = Symbol.for('@raasimpact/arduino-cloud/cloud-client-manager');
  const g = globalThis as unknown as Record<symbol, unknown>;
  delete g[SINGLETON_KEY];
  return CloudClientManager.getInstance();
}

describe('CloudClientManager', () => {
  beforeEach(() => {
    builtClients.length = 0;
    factoryShouldThrow = null;
    onPropertyValueShouldThrow = null;
  });

  afterEach(() => {
    // Best-effort: drop any lingering manager state.
    const SINGLETON_KEY = Symbol.for('@raasimpact/arduino-cloud/cloud-client-manager');
    const g = globalThis as unknown as Record<symbol, unknown>;
    delete g[SINGLETON_KEY];
  });

  it('shares one client across subscriptions on the same credential key', async () => {
    const mgr = freshManager();
    await mgr.subscribe('cred-1', credA, 'thing-1', 'temp', () => {});
    await mgr.subscribe('cred-1', credA, 'thing-2', 'humid', () => {});

    expect(builtClients).toHaveLength(1);
    expect(builtClients[0].connect).toHaveBeenCalledTimes(1);
  });

  it('opens separate clients for distinct credential keys', async () => {
    const mgr = freshManager();
    await mgr.subscribe('cred-A', credA, 'thing-1', 'temp', () => {});
    await mgr.subscribe('cred-B', credB, 'thing-1', 'temp', () => {});

    expect(builtClients).toHaveLength(2);
  });

  it('calls onPropertyValue at the SDK level only once per (thingId, variableName), regardless of handler count', async () => {
    const mgr = freshManager();
    const h1 = vi.fn();
    const h2 = vi.fn();
    const h3 = vi.fn();
    await mgr.subscribe('cred-1', credA, 'thing-1', 'temp', h1);
    await mgr.subscribe('cred-1', credA, 'thing-1', 'temp', h2);
    await mgr.subscribe('cred-1', credA, 'thing-1', 'temp', h3);

    expect(builtClients[0].onPropertyValue).toHaveBeenCalledTimes(1);
  });

  it('demuxes a single SDK delivery to every active handler for that key', async () => {
    const mgr = freshManager();
    const h1 = vi.fn();
    const h2 = vi.fn();
    const hOther = vi.fn(); // different (thingId, variableName) — should NOT see this delivery

    await mgr.subscribe('cred-1', credA, 'thing-1', 'temp', h1);
    await mgr.subscribe('cred-1', credA, 'thing-1', 'temp', h2);
    await mgr.subscribe('cred-1', credA, 'thing-1', 'humid', hOther);

    const client = builtClients[0];
    const tempCb = client.registered.get('thing-1\0temp')!;
    tempCb(42);

    expect(h1).toHaveBeenCalledWith(42);
    expect(h2).toHaveBeenCalledWith(42);
    expect(hOther).not.toHaveBeenCalled();
  });

  it('one handler throwing does not poison sibling handlers on the same key', async () => {
    const mgr = freshManager();
    const bad = vi.fn(() => {
      throw new Error('handler boom');
    });
    const good = vi.fn();

    await mgr.subscribe('cred-1', credA, 'thing-1', 'temp', bad);
    await mgr.subscribe('cred-1', credA, 'thing-1', 'temp', good);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cb = builtClients[0].registered.get('thing-1\0temp')!;
    cb(7);

    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalledWith(7);
    consoleSpy.mockRestore();
  });

  it('disconnects only when the last handler is released, not on the first', async () => {
    const mgr = freshManager();
    const u1 = await mgr.subscribe('cred-1', credA, 'thing-1', 'temp', () => {});
    const u2 = await mgr.subscribe('cred-1', credA, 'thing-2', 'humid', () => {});

    expect(builtClients[0].disconnect).not.toHaveBeenCalled();

    await u1();
    expect(builtClients[0].disconnect).not.toHaveBeenCalled();

    await u2();
    expect(builtClients[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it('two handlers on the same (thingId, variableName) each take a refcount slot', async () => {
    // If the manager only refcounted distinct keys instead of distinct
    // handlers, releasing one of two handlers on the same key would
    // disconnect the client and silently break the surviving handler.
    const mgr = freshManager();
    const u1 = await mgr.subscribe('cred-1', credA, 'thing-1', 'temp', () => {});
    const u2 = await mgr.subscribe('cred-1', credA, 'thing-1', 'temp', () => {});

    await u1();
    expect(builtClients[0].disconnect).not.toHaveBeenCalled();

    await u2();
    expect(builtClients[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it('a failed connect releases the refcount — next subscribe rebuilds the client cleanly', async () => {
    // If the refcount were not restored on connect failure, the entry would
    // be pinned and a later working subscribe would hang or skip the
    // teardown forever.
    const mgr = freshManager();
    factoryShouldThrow = new Error('cloud unreachable');
    await expect(
      mgr.subscribe('cred-1', credA, 'thing-1', 'temp', () => {}),
    ).rejects.toThrow(/cloud unreachable/);

    factoryShouldThrow = null;
    const u = await mgr.subscribe('cred-1', credA, 'thing-1', 'temp', () => {});
    // A second healthy subscribe must work; the broken first one must not
    // leave behind state that blocks teardown.
    await u();
    // The successful client (the second one built — first was a failed attempt)
    // disconnects after the only handler is released.
    const successful = builtClients[builtClients.length - 1];
    expect(successful.disconnect).toHaveBeenCalledTimes(1);
  });

  it('a failed onPropertyValue releases the refcount and tears down if it was the only subscriber', async () => {
    // Same hazard as above, one layer in: the connect succeeded but the
    // subscribe call to the SDK threw. Refcount must drop, the client must
    // disconnect (since nobody else is using it), and a later subscribe
    // must build a fresh client.
    const mgr = freshManager();
    onPropertyValueShouldThrow = new Error('subscribe rejected');
    await expect(
      mgr.subscribe('cred-1', credA, 'thing-1', 'temp', () => {}),
    ).rejects.toThrow(/subscribe rejected/);

    expect(builtClients[0].disconnect).toHaveBeenCalledTimes(1);

    onPropertyValueShouldThrow = null;
    await mgr.subscribe('cred-1', credA, 'thing-1', 'temp', () => {});
    expect(builtClients).toHaveLength(2);
  });

  it('coalesces concurrent subscribes during connect — only one client is constructed', async () => {
    // Two trigger nodes activating in the same tick must not race the
    // connect — both should await the same in-flight pendingConnect and
    // share the resulting client.
    const mgr = freshManager();
    const [u1, u2] = await Promise.all([
      mgr.subscribe('cred-1', credA, 'thing-1', 'temp', () => {}),
      mgr.subscribe('cred-1', credA, 'thing-2', 'humid', () => {}),
    ]);
    expect(builtClients).toHaveLength(1);

    await u1();
    await u2();
    expect(builtClients[0].disconnect).toHaveBeenCalledTimes(1);
  });
});
