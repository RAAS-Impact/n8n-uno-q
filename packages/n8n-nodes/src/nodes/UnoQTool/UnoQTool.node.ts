import {
  NodeOperationError,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
} from 'n8n-workflow';
import { BridgeManager } from '../../BridgeManager.js';
import {
  checkRateLimit,
  countInWindow,
  recordCall,
  resetsInMs,
  type RateLimitWindow,
} from '../../rateLimiter.js';
import { CREDENTIAL_NAME, resolveTransport } from '../../transport-resolver.js';

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
    credentials: [
      {
        name: CREDENTIAL_NAME,
        required: false,
        testedBy: 'unoQRouterApiTest',
      },
    ],
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
        placeholder:
          'e.g. =Turns the onboard LED on or off. Pass true to turn on, false to turn off.{{ $parameter.idempotent ? \'\' : \' Do not retry if this errors.\' }}',
        description:
          'Plain-English description the LLM reads to decide when to call this tool. You can interpolate the Idempotent flag below with an n8n expression — e.g. <code>{{ $parameter.idempotent ? \'\' : \'Do not retry on error — state is unknown.\' }}</code>. Wording that steers an LLM well is model-specific; treat any example as a starting point and tune for your model.',
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
        displayName: 'Idempotent',
        name: 'idempotent',
        type: 'boolean',
        default: false,
        description:
          'Whether calling this method multiple times with the same parameters leaves the MCU in the same state. When on, the bridge auto-retries if the socket drops mid-call (within the remaining timeout budget). Leave off for actuators whose effect compounds (relative moves, pulses, counters). An absolute write like set_valve(closed) is idempotent; a relative move like move_stepper(+100) is not.',
      },
      {
        displayName: 'Method Guard',
        name: 'methodGuard',
        type: 'string',
        typeOptions: { editor: 'jsEditor', rows: 6 },
        default: '',
        placeholder:
          '// Decide whether this invocation should go through.\n// Variables in scope:\n//   method  (string)   — the MCU method name.\n//   params  (array)    — positional args, coerced to their declared types.\n//   budget  (object)   — peek at call history (always present):\n//     budget.used("minute" | "hour" | "day")  → prior calls in that window\n//     budget.remaining                         → calls left under the Rate\n//                                                Limit field, or null if\n//                                                no cap is set\n//     budget.resetsInMs                        → ms until the oldest\n//                                                in-window call rolls off,\n//                                                or null if empty\n//\n// Return true to allow, a string to reject with that exact message,\n// false for a generic rejection, or throw for a hard error.\n\n// Example — clamp an LLM-supplied speed argument:\nif (params[0] > 100) return "Refused: max speed is 100";\nif (params[0] < 0)   return "Refused: speed must be >= 0";\n\n// Example — reserve the last few slots for high-priority calls:\n// if (budget.remaining !== null && budget.remaining < 3 && params[0] < 50) {\n//   return "Refused: near quota, reserving for higher-priority calls";\n// }\n\n// Example — soft cap even without a Rate Limit configured:\n// if (budget.used("minute") > 20) return "Refused: too many calls this minute";\n\nreturn true;',
        description:
          'Optional JavaScript body that runs at invocation time and decides whether the call may proceed. Typical uses: vet the parameters the LLM chose, enforce time-of-day windows, check external state, or make traffic-aware decisions using <code>budget</code>. Variables in scope: <code>method</code> (string), <code>params</code> (array, coerced to their declared types), and <code>budget</code> (object). <code>budget.used(window)</code> returns prior calls recorded in the last <code>"minute"</code>, <code>"hour"</code>, or <code>"day"</code> — works regardless of whether the Rate Limit field is set, so you can write soft caps here. <code>budget.remaining</code> and <code>budget.resetsInMs</code> are numbers when the Rate Limit field is configured and <code>null</code> otherwise. Return <code>true</code>, <code>undefined</code>, or <code>null</code> to allow the call. Return <code>false</code> to reject with a generic message. Return any string to reject with that exact message — when wired to an AI Agent, the string is fed back as tool output so the LLM can self-correct. Throwing surfaces the thrown message prefixed with <code>"Method guard threw:"</code>. Runs without a sandbox — same trust model as the n8n Code node. Leave empty to skip.',
      },
      {
        displayName: 'Rate Limit',
        name: 'rateLimit',
        type: 'collection',
        placeholder: 'Add Rate Limit',
        default: {},
        description:
          'Cap how often this method may be invoked. Exceeding the limit short-circuits the call with a rejection string the LLM can read — same path as the Method Guard. Counters are in-memory per n8n process; they reset on container restart and are not shared across queue-mode workers.',
        options: [
          {
            displayName: 'Max Calls',
            name: 'maxCalls',
            type: 'number',
            default: 10,
            typeOptions: { minValue: 1 },
            description: 'Maximum invocations allowed within the selected window.',
          },
          {
            displayName: 'Per',
            name: 'window',
            type: 'options',
            options: [
              { name: 'Minute', value: 'minute' },
              { name: 'Hour', value: 'hour' },
              { name: 'Day', value: 'day' },
            ],
            default: 'minute',
            description: 'Sliding time window against which Max Calls is measured.',
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
            displayName: 'Timeout (ms)',
            name: 'timeout',
            type: 'number',
            default: DEFAULT_TIMEOUT_MS,
            description: 'How long to wait for the MCU response before erroring the tool call.',
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
        const idempotent = this.getNodeParameter('idempotent', i, false) as boolean;

        const { descriptor, credentialId, sshCredential } = await resolveTransport(
          this,
          options.socketPath,
          i,
        );

        const params = buildParams(this, mode, i);

        // Counter key shared between Rate Limit enforcer and guard's budget
        // view. Include credentialId so that a single node re-pointed at a
        // different Q (via credential edit) starts fresh history against the
        // new target instead of carrying the old Q's call rate into it.
        const counterKey = credentialId
          ? `${this.getNode().id}:${method}:${credentialId}`
          : `${this.getNode().id}:${method}`;
        const rateLimit = this.getNodeParameter('rateLimit', i, {}) as {
          maxCalls?: number;
          window?: RateLimitWindow;
        };
        const rateLimitCap =
          rateLimit.maxCalls && rateLimit.maxCalls > 0 ? rateLimit.maxCalls : null;
        const rateLimitWindow: RateLimitWindow = rateLimit.window ?? 'minute';

        if (rateLimitCap !== null) {
          const verdict = checkRateLimit(counterKey, rateLimitCap, rateLimitWindow);
          if (!verdict.allowed) {
            const retrySeconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
            const msg = `Refused: rate limit of ${rateLimitCap} per ${rateLimitWindow} exceeded. Retry in ~${retrySeconds}s.`;
            returnData.push({
              json: { method, params, refused: true, error: msg },
              pairedItem: { item: i },
            });
            continue;
          }
        }

        const budget = buildBudget(counterKey, rateLimitCap, rateLimitWindow);

        const guardBody = (this.getNodeParameter('methodGuard', i, '') as string).trim();
        const rejection = guardBody
          ? runMethodGuard(this, guardBody, method, params, budget, i)
          : null;

        if (rejection !== null) {
          returnData.push({
            json: { method, params, refused: true, error: rejection },
            pairedItem: { item: i },
          });
          continue;
        }

        // Record only after both gates pass — a rejected call should not
        // consume budget that a later legitimate call might need.
        recordCall(counterKey);

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

interface GuardBudget {
  used: (window: RateLimitWindow) => number;
  remaining: number | null;
  resetsInMs: number | null;
}

function buildBudget(
  counterKey: string,
  cap: number | null,
  capWindow: RateLimitWindow,
): GuardBudget {
  return {
    used: (window: RateLimitWindow) => countInWindow(counterKey, window),
    remaining: cap !== null ? Math.max(0, cap - countInWindow(counterKey, capWindow)) : null,
    resetsInMs: cap !== null ? resetsInMs(counterKey, capWindow) : null,
  };
}

function runMethodGuard(
  ctx: IExecuteFunctions,
  body: string,
  method: string,
  params: unknown[],
  budget: GuardBudget,
  itemIndex: number,
): string | null {
  let verdict: unknown;
  try {
    verdict = new Function('method', 'params', 'budget', body)(method, params, budget);
  } catch (err) {
    throw new NodeOperationError(
      ctx.getNode(),
      `Method guard threw: ${err instanceof Error ? err.message : String(err)}`,
      { itemIndex },
    );
  }
  if (verdict === true || verdict === undefined || verdict === null) return null;
  if (verdict === false) return 'Method guard rejected the call';
  if (typeof verdict === 'string') return verdict;
  throw new NodeOperationError(
    ctx.getNode(),
    `Method guard returned an unexpected value (${typeof verdict}); expected true/undefined, false, or a string`,
    { itemIndex },
  );
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
