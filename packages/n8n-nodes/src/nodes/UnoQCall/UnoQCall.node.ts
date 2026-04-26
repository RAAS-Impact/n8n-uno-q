import {
  NodeOperationError,
  type ICredentialTestFunctions,
  type ICredentialsDecrypted,
  type IExecuteFunctions,
  type INodeCredentialTestResult,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
} from 'n8n-workflow';
import { Bridge } from '@raasimpact/arduino-uno-q-bridge';
import { BridgeManager } from '../../BridgeManager.js';
import {
  CREDENTIAL_NAME,
  descriptorFromCredential,
  resolveTransport,
  type UnoQRouterCredential,
} from '../../transport-resolver.js';

type ParameterType = 'string' | 'number' | 'boolean' | 'json';
type ParametersMode = 'none' | 'fields' | 'json';

interface FieldParameter {
  type: ParameterType;
  value: string;
}

interface CallOptions {
  timeout?: number;
  socketPath?: string;
}

const DEFAULT_SOCKET = '/var/run/arduino-router.sock';
const DEFAULT_TIMEOUT_MS = 5000;
const CRED_TEST_FN = 'unoQRouterApiTest';

export class UnoQCall implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Arduino UNO Q Call',
    name: 'unoQCall',
    icon: 'file:unoQCall.svg',
    group: ['transform'],
    version: 1,
    description: 'Call a method on the Arduino UNO Q router',
    defaults: { name: 'Arduino UNO Q Call' },
    codex: {
      alias: ['Arduino', 'UNO Q', 'MCU', 'microcontroller', 'router', 'bridge'],
    },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [
      {
        name: CREDENTIAL_NAME,
        // Not required yet — one release cycle of backwards compatibility
        // with the legacy per-node "Socket Path" option. The next major
        // release flips this to required: true and drops the option.
        required: false,
        testedBy: CRED_TEST_FN,
      },
    ],
    properties: [
      {
        displayName: 'Method',
        name: 'method',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'e.g. set_led_state',
        description:
          'Name of the MCU method to call. Must match a Bridge.provide() name in your sketch.',
      },
      {
        displayName: 'Specify Parameters',
        name: 'parametersMode',
        type: 'options',
        options: [
          { name: 'None', value: 'none', description: 'Method takes no arguments' },
          { name: 'Fields', value: 'fields', description: 'Add parameters as a typed, ordered list' },
          { name: 'JSON', value: 'json', description: 'Provide parameters as a raw JSON array' },
        ],
        default: 'fields',
      },
      {
        displayName: 'Parameters',
        name: 'parameters',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true, sortable: true },
        default: {},
        placeholder: 'Add Parameter',
        displayOptions: { show: { parametersMode: ['fields'] } },
        description:
          'Positional arguments passed to the MCU method, in the order shown. For variadic or complex payloads, switch to JSON mode.',
        options: [
          {
            displayName: 'Parameter',
            name: 'parameter',
            values: [
              {
                displayName: 'Type',
                name: 'type',
                type: 'options',
                options: [
                  { name: 'String', value: 'string' },
                  { name: 'Number', value: 'number' },
                  { name: 'Boolean', value: 'boolean' },
                  { name: 'JSON', value: 'json' },
                ],
                default: 'string',
              },
              {
                displayName: 'Value',
                name: 'value',
                type: 'string',
                default: '',
                description:
                  'Value to send. For Boolean use true/false. For JSON use any valid JSON value (object, array, number, null, …).',
              },
            ],
          },
        ],
      },
      {
        displayName: 'Parameters (JSON)',
        name: 'parametersJson',
        type: 'json',
        default: '[]',
        displayOptions: { show: { parametersMode: ['json'] } },
        description:
          'Parameters as a JSON array, e.g. [true, 42, {"foo": "bar"}]. The array is passed positionally to the MCU method.',
      },
      {
        displayName: 'Idempotent',
        name: 'idempotent',
        type: 'boolean',
        default: false,
        description:
          'Whether calling this method multiple times with the same parameters leaves the MCU in the same state. When on, the bridge auto-retries if the socket drops mid-call (within the remaining timeout budget). Leave off for actuators whose effect compounds (relative moves, pulses, counters). An absolute write like set_valve(closed) is idempotent; a relative move like move_stepper(+100) is not.',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        options: [
          {
            displayName: 'Timeout (ms)',
            name: 'timeout',
            type: 'number',
            default: DEFAULT_TIMEOUT_MS,
            description: 'How long to wait for the MCU response before erroring.',
          },
          {
            displayName: 'Socket Path (Deprecated)',
            name: 'socketPath',
            type: 'string',
            default: '',
            placeholder: DEFAULT_SOCKET,
            description:
              'Deprecated. Assign an "Arduino UNO Q Router" credential to this node instead. This field is honoured only when no credential is assigned and will be removed in the next major release.',
          },
        ],
      },
    ],
  };

  methods = {
    credentialTest: {
      [CRED_TEST_FN]: testUnoQRouterApi,
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];
    const manager = BridgeManager.getInstance();

    for (let i = 0; i < items.length; i++) {
      try {
        const method = (this.getNodeParameter('method', i) as string).trim();
        if (!method) {
          throw new NodeOperationError(this.getNode(), 'Method name is required', {
            itemIndex: i,
          });
        }

        const mode = this.getNodeParameter('parametersMode', i) as ParametersMode;
        const options = this.getNodeParameter('options', i, {}) as CallOptions;
        const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
        const idempotent = this.getNodeParameter('idempotent', i, false) as boolean;

        const { descriptor, sshCredential } = await resolveTransport(this, options.socketPath, i);
        const params = buildParams(this, mode, i);

        const bridge = await manager.getBridge(descriptor, { sshCredential });
        const result = await bridge.callWithOptions(method, params, {
          timeoutMs: timeout,
          idempotent,
        });

        returnData.push({
          json: { method, params, result: result ?? null },
          pairedItem: { item: i },
        });
      } catch (err) {
        if (this.continueOnFail()) {
          returnData.push({
            json: { error: err instanceof Error ? err.message : String(err) },
            pairedItem: { item: i },
          });
          continue;
        }
        throw err;
      }
    }

    return [returnData];
  }
}

/**
 * Credential test for `unoQRouterApi`. n8n discovers this by name because the
 * credential description (`testedBy: 'unoQRouterApiTest'`) references it
 * through any node that declares the credential. Lives on UnoQCall because
 * Call is the simplest node that touches a bridge — any of the three would
 * do; Call minimises surprise.
 */
async function testUnoQRouterApi(
  this: ICredentialTestFunctions,
  credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
  const data = credential.data as UnoQRouterCredential | undefined;
  if (!data) {
    return { status: 'Error', message: 'Credential data is empty.' };
  }

  try {
    const descriptor = descriptorFromCredential(
      // Synthetic INode shape — descriptorFromCredential only needs `name`
      // for error messages, not a real node. The NodeOperationError it
      // throws is caught below and surfaced to the user.
      { name: credential.name ?? 'credential' } as never,
      data,
    );
    const bridge = await Bridge.connect({
      transport: descriptor,
      reconnect: { enabled: false },
    });
    try {
      const version = await bridge.callWithOptions('$/version', [], {
        idempotent: true,
        timeoutMs: 3000,
      });
      return {
        status: 'OK',
        message: `Connected — arduino-router ${String(version)}`,
      };
    } finally {
      await bridge.close();
    }
  } catch (err) {
    return {
      status: 'Error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildParams(ctx: IExecuteFunctions, mode: ParametersMode, i: number): unknown[] {
  if (mode === 'none') return [];

  if (mode === 'json') {
    const raw = ctx.getNodeParameter('parametersJson', i, '[]') as unknown;
    let parsed: unknown;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err) {
      throw new NodeOperationError(
        ctx.getNode(),
        `Parameters (JSON) is not valid JSON: ${(err as Error).message}`,
        { itemIndex: i },
      );
    }
    if (!Array.isArray(parsed)) {
      throw new NodeOperationError(ctx.getNode(), 'Parameters (JSON) must be a JSON array', {
        itemIndex: i,
      });
    }
    return parsed;
  }

  const collection = ctx.getNodeParameter('parameters', i, {}) as {
    parameter?: FieldParameter[];
  };
  const entries = collection.parameter ?? [];
  return entries.map((entry, idx) => coerce(ctx, entry.type, entry.value, i, idx));
}

function coerce(
  ctx: IExecuteFunctions,
  type: ParameterType,
  raw: unknown,
  itemIndex: number,
  paramIndex: number,
): unknown {
  switch (type) {
    case 'string':
      return raw == null ? '' : String(raw);

    case 'number': {
      if (typeof raw === 'number') return raw;
      const s = String(raw).trim();
      const n = Number(s);
      if (s === '' || Number.isNaN(n)) {
        throw new NodeOperationError(
          ctx.getNode(),
          `Parameter #${paramIndex + 1}: "${raw}" is not a valid number`,
          { itemIndex },
        );
      }
      return n;
    }

    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).trim().toLowerCase();
      if (s === 'true' || s === '1') return true;
      if (s === 'false' || s === '0' || s === '') return false;
      throw new NodeOperationError(
        ctx.getNode(),
        `Parameter #${paramIndex + 1}: "${raw}" is not a valid boolean (use true/false)`,
        { itemIndex },
      );
    }

    case 'json': {
      if (typeof raw !== 'string') return raw;
      try {
        return JSON.parse(raw);
      } catch (err) {
        throw new NodeOperationError(
          ctx.getNode(),
          `Parameter #${paramIndex + 1}: invalid JSON — ${(err as Error).message}`,
          { itemIndex },
        );
      }
    }
  }
}
