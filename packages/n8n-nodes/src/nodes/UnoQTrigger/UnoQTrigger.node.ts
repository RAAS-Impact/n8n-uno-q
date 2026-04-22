import {
  NodeOperationError,
  type IDataObject,
  type INodeType,
  type INodeTypeDescription,
  type ITriggerFunctions,
  type ITriggerResponse,
} from 'n8n-workflow';
import { describeTransport } from '@raasimpact/arduino-uno-q-bridge';
import { BridgeManager } from '../../BridgeManager.js';
import { PendingRequests } from '../../PendingRequests.js';
import { CREDENTIAL_NAME, resolveTransport } from '../../transport-resolver.js';

type TriggerMode = 'notify' | 'request';
type ResponseMode = 'immediate' | 'deferred';

interface TriggerOptions {
  socketPath?: string;
  ackValue?: string;
  timeoutMs?: number;
}

const DEFAULT_SOCKET = '/var/run/arduino-router.sock';
const DEFAULT_ACK = 'true';
const DEFAULT_DEFERRED_TIMEOUT_MS = 30000;

export class UnoQTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Arduino UNO Q Trigger',
    name: 'unoQTrigger',
    icon: 'file:unoQTrigger.svg',
    group: ['trigger'],
    version: 1,
    description: 'Trigger a workflow on events from the Arduino UNO Q MCU',
    defaults: { name: 'Arduino UNO Q Trigger' },
    codex: {
      alias: ['Arduino', 'UNO Q', 'MCU', 'microcontroller', 'router', 'bridge'],
    },
    inputs: [],
    outputs: ['main'],
    credentials: [
      {
        name: CREDENTIAL_NAME,
        // Not required yet — one release cycle of backwards compatibility
        // with the legacy per-node "Socket Path" option. The next major
        // release flips this to required: true and drops the option.
        required: false,
        testedBy: 'unoQRouterApiTest',
      },
    ],
    properties: [
      {
        displayName: 'Method',
        name: 'method',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'e.g. button_pressed',
        description:
          'Method name to register on the router. Fires whenever the MCU calls or notifies this name via Bridge.notify() or Bridge.call().',
      },
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'notify',
        options: [
          {
            name: 'Notification',
            value: 'notify',
            description:
              'Listen for fire-and-forget Bridge.notify() from the MCU. Multiple triggers can share the same method.',
          },
          {
            name: 'Request',
            value: 'request',
            description:
              'Act as the RPC handler for Bridge.call() from the MCU. Only one trigger can own a method.',
          },
        ],
      },
      {
        displayName: 'Response Mode',
        name: 'responseMode',
        type: 'options',
        default: 'immediate',
        displayOptions: { show: { mode: ['request'] } },
        options: [
          {
            name: 'Acknowledge Immediately',
            value: 'immediate',
            description:
              'Return the configured ack value as soon as the event arrives. The workflow runs in parallel; its result never reaches the MCU.',
          },
          {
            name: 'Wait for Respond Node',
            value: 'deferred',
            description:
              'Hold the RPC response open until an Arduino UNO Q Respond node sends a value. The workflow must reach a Respond node before the timeout.',
          },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        options: [
          {
            displayName: 'Socket Path (Deprecated)',
            name: 'socketPath',
            type: 'string',
            default: '',
            placeholder: DEFAULT_SOCKET,
            description:
              'Deprecated. Assign an "Arduino UNO Q Router" credential to this node instead. This field is honoured only when no credential is assigned and will be removed in the next major release.',
          },
          {
            displayName: 'Ack Value (JSON)',
            name: 'ackValue',
            type: 'string',
            default: DEFAULT_ACK,
            displayOptions: {
              show: { '/mode': ['request'], '/responseMode': ['immediate'] },
            },
            description:
              'Value returned to the MCU. Parsed as JSON (true, 42, "ok", {"status":"received"}). Falls back to the raw string if not valid JSON.',
          },
          {
            displayName: 'Response Timeout (ms)',
            name: 'timeoutMs',
            type: 'number',
            default: DEFAULT_DEFERRED_TIMEOUT_MS,
            displayOptions: {
              show: { '/mode': ['request'], '/responseMode': ['deferred'] },
            },
            description:
              'How long to wait for a Respond node before sending a timeout error to the MCU. Keep higher than the MCU-side Bridge.call() timeout so errors surface here with a clear message.',
          },
        ],
      },
    ],
  };

  async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
    const method = (this.getNodeParameter('method') as string).trim();
    if (!method) {
      throw new NodeOperationError(this.getNode(), 'Method name is required');
    }

    const mode = this.getNodeParameter('mode') as TriggerMode;
    const responseMode: ResponseMode =
      mode === 'request'
        ? (this.getNodeParameter('responseMode') as ResponseMode)
        : 'immediate';
    const options = this.getNodeParameter('options', {}) as TriggerOptions;

    const { descriptor } = await resolveTransport(this, options.socketPath);
    // Canonical transport string — included in the _unoQRequest envelope so
    // a downstream Respond node can distinguish pending requests from
    // different Qs if the user ever routes them through a shared PendingRequests.
    const transport = describeTransport(descriptor);

    const manager = BridgeManager.getInstance();
    const bridge = await manager.acquire(descriptor);
    manager.addMethodRef(descriptor, method);

    const emit = (data: IDataObject) => {
      this.emit([this.helpers.returnJsonArray([data])]);
    };

    let unsubscribe: () => void | Promise<void> = () => {};

    try {
      if (mode === 'notify') {
        const unsub = await bridge.onNotify(method, (params) => {
          emit({ method, params });
        });
        unsubscribe = unsub;
      } else if (responseMode === 'immediate') {
        const ack = parseJsonOrString(options.ackValue ?? DEFAULT_ACK);
        await bridge.provide(method, (params) => {
          emit({ method, params });
          return ack;
        });
      } else {
        const timeoutMs = options.timeoutMs ?? DEFAULT_DEFERRED_TIMEOUT_MS;
        const pending = PendingRequests.getInstance();
        await bridge.provide(method, (params, msgid) => {
          return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
              if (pending.take(msgid)) {
                reject(
                  new Error(
                    `No Arduino UNO Q Respond node answered within ${timeoutMs} ms`,
                  ),
                );
              }
            }, timeoutMs);
            pending.register(msgid, { resolve, reject, timer });
            emit({
              method,
              params,
              _unoQRequest: { msgid, transport },
            });
          });
        });
      }
    } catch (err) {
      manager.removeMethodRef(descriptor, method);
      await manager.release(descriptor);
      if (mode === 'request') {
        throw new NodeOperationError(
          this.getNode(),
          `Failed to register "${method}" as request handler: ${(err as Error).message}. ` +
            `Another trigger may already own this method — use Notification mode to share it.`,
        );
      }
      throw err;
    }

    const closeFunction = async () => {
      await unsubscribe();
      manager.removeMethodRef(descriptor, method);
      await manager.release(descriptor);
    };

    return { closeFunction };
  }
}

function parseJsonOrString(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}
