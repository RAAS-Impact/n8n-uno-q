/**
 * ArduinoCloudTrigger — tests focused on the contracts that *cross* the
 * node/manager boundary, since those are what break when either side is
 * refactored in isolation.
 *
 *   - The exact data shape downstream nodes see when a property updates
 *     (this is the trigger's user-facing API).
 *   - The trigger's lifecycle wires up to the manager's refcount: subscribe
 *     on activate, unsubscribe on deactivate. A leak here means an MQTT
 *     connection survives a workflow being toggled off, which silently
 *     keeps charging quota and double-fires when reactivated.
 *   - The credential identity used as the manager's key — same credential
 *     across two triggers must collapse to one connection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { subscribeMock, unsubscribeMock, getInstanceMock } = vi.hoisted(() => ({
  subscribeMock: vi.fn(),
  unsubscribeMock: vi.fn(),
  getInstanceMock: vi.fn(),
}));

vi.mock('../src/cloudClientManager.js', () => ({
  CloudClientManager: { getInstance: getInstanceMock },
}));

import { ArduinoCloudTrigger } from '../src/nodes/ArduinoCloudTrigger/ArduinoCloudTrigger.node.js';

interface TriggerParams {
  thingId?: string;
  variableName?: string;
}

interface TriggerCtxOpts {
  credentialId?: string;
  emit?: (data: unknown[]) => void;
}

function makeTriggerCtx(params: TriggerParams, opts: TriggerCtxOpts = {}): unknown {
  return {
    getNodeParameter: (name: string) => {
      if (name === 'thingId') return params.thingId ?? '';
      if (name === 'variableName') return params.variableName ?? '';
      throw new Error(`fake trigger ctx: no param "${name}"`);
    },
    getNode: () => ({
      id: 'trigger-1',
      name: 'ArduinoCloudTrigger',
      type: 'n8n-nodes-arduino-cloud.arduinoCloudTrigger',
      typeVersion: 1,
      credentials: {
        arduinoCloudOAuth2Api: { id: opts.credentialId ?? 'cred-X', name: 'stub' },
      },
    }),
    getCredentials: async () => ({
      clientId: 'cid',
      clientSecret: 'csecret',
      organizationId: '',
    }),
    emit: opts.emit ?? (() => {}),
    helpers: {
      returnJsonArray: (data: object[]) => data.map((json) => ({ json })),
    },
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
  };
}

describe('ArduinoCloudTrigger', () => {
  beforeEach(() => {
    subscribeMock.mockReset();
    unsubscribeMock.mockReset();
    getInstanceMock.mockReset();
    getInstanceMock.mockReturnValue({ subscribe: subscribeMock });
    subscribeMock.mockResolvedValue(unsubscribeMock);
  });

  it('emits a json item shaped { thingId, variableName, value, receivedAt } on each property update', async () => {
    // This is the *only* contract a downstream node author can rely on. If
    // any of these fields disappear, every workflow built on this trigger
    // breaks silently.
    const node = new ArduinoCloudTrigger();
    const emitted: unknown[][] = [];
    const ctx = makeTriggerCtx(
      { thingId: 'thing-1', variableName: 'temperature' },
      { emit: (d) => emitted.push(d) },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (node.trigger as any).call(ctx);

    const handler = subscribeMock.mock.calls[0][4] as (v: unknown) => void;
    handler(21.5);

    expect(emitted).toHaveLength(1);
    const [batch] = emitted[0] as [Array<{ json: Record<string, unknown> }>];
    expect(batch).toHaveLength(1);
    expect(batch[0].json).toMatchObject({
      thingId: 'thing-1',
      variableName: 'temperature',
      value: 21.5,
    });
    expect(typeof batch[0].json.receivedAt).toBe('string');
    // ISO-8601 — the entire timestamp story relies on n8n date-extension
    // helpers parsing this format. Lock it.
    expect(batch[0].json.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('closeFunction unsubscribes — no MQTT subscription leaks past workflow deactivation', async () => {
    // n8n calls closeFunction whenever the workflow is deactivated, edited,
    // or reloaded. A leaked unsubscribe leaves a dangling handler that will
    // fire stale workflow runs on the next reload, plus eats the credential
    // budget. This is the load-bearing reason the manager exists at all.
    const node = new ArduinoCloudTrigger();
    const ctx = makeTriggerCtx({ thingId: 'thing-1', variableName: 'temperature' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (node.trigger as any).call(ctx);
    await response.closeFunction();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it('uses the n8n credential id as the manager key — same credential collapses to one connection across nodes', async () => {
    // Two triggers in the same workflow that point at the same credential
    // must hand the manager the *same* key, otherwise the manager opens
    // two MQTT connections instead of refcounting one — defeating the
    // whole point of the manager.
    const node = new ArduinoCloudTrigger();
    const ctx1 = makeTriggerCtx(
      { thingId: 'thing-A', variableName: 'temp' },
      { credentialId: 'cred-prod' },
    );
    const ctx2 = makeTriggerCtx(
      { thingId: 'thing-B', variableName: 'humid' },
      { credentialId: 'cred-prod' },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (node.trigger as any).call(ctx1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (node.trigger as any).call(ctx2);

    const key1 = subscribeMock.mock.calls[0][0];
    const key2 = subscribeMock.mock.calls[1][0];
    expect(key1).toBe('cred-prod');
    expect(key2).toBe('cred-prod');
  });
});
