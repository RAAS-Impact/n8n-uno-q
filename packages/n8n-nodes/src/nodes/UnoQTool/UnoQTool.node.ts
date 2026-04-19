import {
  NodeOperationError,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
} from 'n8n-workflow';
import { BridgeManager } from '../../BridgeManager.js';

type ParameterType = 'string' | 'number' | 'boolean' | 'json';
type ParametersMode = 'none' | 'fields' | 'json';

interface FieldParameter {
  type: ParameterType;
  value: string;
}

interface ToolOptions {
  timeout?: number;
  socketPath?: string;
}

const DEFAULT_SOCKET = '/var/run/arduino-router.sock';
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * `usableAsTool: true` is the supported community-node idiom for exposing a
 * node to the AI Agent (see n8n PR #26007 and nerding-io/n8n-nodes-mcp). The
 * `supplyData` + `outputs: ['ai_tool']` pattern used by @n8n/nodes-langchain
 * is internal-only; community nodes that use it get misrouted onto the main
 * execution graph and fail with "has supplyData but no execute".
 *
 * When the user wires this node into an Agent's Tool port, n8n auto-wraps
 * `execute()` into a LangChain DynamicStructuredTool. The LLM fills any
 * parameter whose value contains `$fromAI('name', 'desc', 'type')`; static
 * values pass through unchanged. Wired into a normal workflow it runs as
 * any other action node — the node is dual-purpose.
 */
export class UnoQTool implements INodeType {
  description: INodeTypeDescription = {
    // displayName intentionally does not end in "Tool" — n8n's AI-agent
    // wrapper appends " Tool" to `usableAsTool` nodes in the agent's tool
    // list, which would otherwise yield "Arduino UNO Q Tool Tool".
    displayName: 'Arduino UNO Q Method',
    name: 'unoQTool',
    icon: 'file:unoQTool.svg',
    group: ['transform'],
    version: 1,
    description: 'Expose one Arduino UNO Q method to an AI Agent as a callable tool',
    defaults: { name: 'Arduino UNO Q Method' },
    codex: {
      categories: ['AI'],
      subcategories: { AI: ['Tools'] },
      alias: ['Arduino', 'UNO Q', 'MCU', 'microcontroller', 'router', 'bridge'],
    },
    usableAsTool: true,
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName:
          'To use this node as an AI tool: connect its output to an AI Agent\'s Tool port, then use <code>$fromAI(\'name\', \'description\', \'type\')</code> expressions in the parameter values below. The LLM fills those at runtime.',
        name: 'notice',
        type: 'notice',
        default: '',
      },
      {
        displayName: 'Description',
        name: 'toolDescription',
        type: 'string',
        typeOptions: { rows: 3 },
        default: '',
        required: true,
        placeholder: 'e.g. Turns the onboard LED on or off. Pass true to turn on, false to turn off.',
        description:
          'Plain-English description the LLM reads to decide when to call this tool. Be clear and action-oriented.',
      },
      {
        displayName: 'Method',
        name: 'method',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'e.g. set_led_state',
        description:
          'MCU method name — must match a Bridge.provide() name in your sketch.',
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
          'Positional arguments to the MCU method, in order. Put <code>$fromAI(\'name\', \'desc\', \'type\')</code> in a Value field to have the LLM fill it.',
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
                  'Static value or <code>$fromAI(...)</code> expression. For Boolean use true/false. For JSON use any valid JSON value.',
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
          'Parameters as a JSON array, e.g. [true, 42, {"foo": "bar"}]. Passed positionally to the MCU method.',
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
            description: 'How long to wait for the MCU response before erroring the tool call.',
          },
          {
            displayName: 'Socket Path',
            name: 'socketPath',
            type: 'string',
            default: DEFAULT_SOCKET,
            description:
              'Path to the arduino-router Unix socket. Change only for non-standard deployments.',
          },
        ],
      },
    ],
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
        const options = this.getNodeParameter('options', i, {}) as ToolOptions;
        const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
        const socketPath = options.socketPath || DEFAULT_SOCKET;

        const params = buildParams(this, mode, i);

        const bridge = await manager.getBridge(socketPath);
        const result = await bridge.callWithTimeout(method, timeout, ...params);

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
