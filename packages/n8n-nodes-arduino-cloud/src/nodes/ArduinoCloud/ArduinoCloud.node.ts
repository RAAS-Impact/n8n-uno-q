/**
 * ArduinoCloud — action node for reading and writing Arduino Cloud Properties.
 *
 * Marked `usableAsTool: true` so it drops into a Tools Agent's tool connector
 * without wrapping. Any parameter whose value is a `$fromAI('name','desc','type')`
 * expression is filled by the LLM at invocation time; static values pass
 * through unchanged. Same safety primitives as UnoQTool: Property Guard +
 * Rate Limit, so the agent can be given write access to a real IoT device
 * without turning the workflow into a free-for-all.
 *
 * v1 scope: Resource = Property only, Operations = Get / Set / GetHistory.
 * Resource/Operation dropdowns are wired so adding more resources (Things,
 * Devices, ...) later is non-breaking — we just add options.
 */
import {
  NodeOperationError,
  type ICredentialTestFunctions,
  type ICredentialsDecrypted,
  type IDataObject,
  type IExecuteFunctions,
  type ILoadOptionsFunctions,
  type INodeCredentialTestResult,
  type INodeExecutionData,
  type INodePropertyOptions,
  type INodeType,
  type INodeTypeDescription,
} from 'n8n-workflow';
// Named imports — the SDK ships no `default` export; see arduinoCloudApi.ts
// for the full story.
import { ApiClient, ThingsV2Api } from '@arduino/arduino-iot-client';
import {
  getProperty,
  historicData,
  listProperties,
  listThings,
  publishProperty,
} from '../../arduinoCloudApi.js';
import { fetchToken, type TokenRequest } from '../../auth/tokenCache.js';
import { runGuard } from '../../guard.js';
import {
  checkRateLimit,
  countInWindow,
  recordCall,
  resetsInMs,
  type RateLimitWindow,
} from '../../rateLimiter.js';

const CREDENTIAL_NAME = 'arduinoCloudOAuth2Api';
const CRED_TEST_FN = 'arduinoCloudOAuth2ApiTest';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_HISTORY_LOOKBACK_MS = 60 * 60 * 1000; // 1h

interface CredentialData {
  clientId: string;
  clientSecret: string;
  organizationId?: string;
}

function credentialRequest(data: CredentialData): TokenRequest {
  return {
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    organizationId: data.organizationId?.trim() || undefined,
  };
}

export class ArduinoCloud implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Arduino Cloud',
    name: 'arduinoCloud',
    icon: 'file:arduinoCloud.svg',
    group: ['transform'],
    version: 1,
    description:
      'Read, write, and query historic values of Arduino Cloud Thing Properties. AI-tool-ready with Property Guard + Rate Limit.',
    defaults: { name: 'Arduino Cloud' },
    codex: {
      categories: ['AI'],
      subcategories: { AI: ['Tools'] },
      alias: ['Arduino', 'Cloud', 'IoT', 'Thing', 'Property', 'MQTT'],
    },
    usableAsTool: true,
    inputs: ['main'],
    outputs: ['main'],
    credentials: [
      {
        name: CREDENTIAL_NAME,
        required: true,
        testedBy: CRED_TEST_FN,
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
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        default: 'property',
        options: [{ name: 'Property', value: 'property' }],
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['property'] } },
        default: 'get',
        options: [
          {
            name: 'Get',
            value: 'get',
            description: 'Read the current value of a property',
            action: 'Get a property value',
          },
          {
            name: 'Set',
            value: 'set',
            description: 'Write a new value to a property',
            action: 'Set a property value',
          },
          {
            name: 'Get History',
            value: 'getHistory',
            description: 'Read historic time-series values of a property',
            action: 'Get historic values of a property',
          },
        ],
      },
      {
        displayName: 'Thing Name or ID',
        name: 'thingId',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'listThings' },
        default: '',
        required: true,
        description:
          'The Thing that owns the property. Choose from the list, or use an <a href="https://docs.n8n.io/code-examples/expressions/">expression</a>.',
      },
      {
        displayName: 'Property Name or ID',
        name: 'propertyId',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'listProperties',
          loadOptionsDependsOn: ['thingId'],
        },
        default: '',
        required: true,
        description:
          'The property to operate on. Loaded from the Thing above; refresh if you just added it in the Arduino Cloud UI.',
      },
      {
        displayName: 'Value',
        name: 'value',
        type: 'string',
        default: '',
        displayOptions: { show: { resource: ['property'], operation: ['set'] } },
        description:
          'Value to publish. For numbers and booleans, type the literal (42, true). For Location or Color variables, provide an object via expression (e.g. <code>{{ { lat: 45.5, lon: 9.2 } }}</code>). The value is passed through to Arduino Cloud, which validates it against the property\'s declared type.',
        required: true,
      },
      {
        displayName: 'Value Type',
        name: 'valueType',
        type: 'options',
        default: 'auto',
        displayOptions: { show: { resource: ['property'], operation: ['set'] } },
        options: [
          {
            name: 'Auto',
            value: 'auto',
            description:
              'Parse booleans, numbers, and JSON objects/arrays automatically; fall back to string.',
          },
          { name: 'String', value: 'string' },
          { name: 'Number', value: 'number' },
          { name: 'Boolean', value: 'boolean' },
          {
            name: 'JSON',
            value: 'json',
            description: 'Parse the Value field as a JSON literal (object, array, null, …).',
          },
        ],
        description:
          'How to interpret the Value field before sending. Auto handles the common cases; use an explicit type if Auto guesses wrong (e.g. a digit-only string that must stay a string).',
      },
      {
        displayName: 'From',
        name: 'from',
        type: 'dateTime',
        default: '',
        displayOptions: { show: { resource: ['property'], operation: ['getHistory'] } },
        description:
          'Start of the time range (inclusive). Leave empty for "1 hour ago". Accepts any value n8n\'s expression editor produces.',
      },
      {
        displayName: 'To',
        name: 'to',
        type: 'dateTime',
        default: '',
        displayOptions: { show: { resource: ['property'], operation: ['getHistory'] } },
        description:
          'End of the time range (exclusive). Leave empty for "now".',
      },
      {
        displayName: 'Idempotent',
        name: 'idempotent',
        type: 'boolean',
        default: false,
        displayOptions: { show: { resource: ['property'], operation: ['set'] } },
        description:
          'Whether writing this property with the same value leaves the device in the same state. Absolute writes (set_valve to "closed", set_target_temp to 21) are idempotent; relative or accumulating writes are not. Reserved for a future auto-retry behaviour on transient network failures — has no runtime effect in this version.',
      },
      {
        displayName: 'Property Guard',
        name: 'propertyGuard',
        type: 'string',
        typeOptions: { editor: 'jsEditor', rows: 6 },
        default: '',
        displayOptions: { show: { resource: ['property'] } },
        placeholder:
          '// Decide whether this invocation should go through.\n// Variables in scope:\n//   operation  (string)   — "get", "set", or "getHistory".\n//   thingId    (string)\n//   propertyId (string)\n//   value      (any)      — the parsed Value, for Set operations only.\n//   budget     (object)   — peek at call history:\n//     budget.used("minute" | "hour" | "day")  → prior calls in that window\n//     budget.remaining                         → calls left under the Rate\n//                                                Limit field, or null if\n//                                                no cap is set\n//     budget.resetsInMs                        → ms until the oldest\n//                                                in-window call rolls off,\n//                                                or null if empty\n//\n// Return true to allow, a string to reject with that exact message,\n// false for a generic rejection, or throw for a hard error.\n\n// Example — clamp an LLM-supplied thermostat setpoint:\n// if (operation === "set" && (value < 15 || value > 26)) {\n//   return "Refused: set point must be between 15 and 26 degrees.";\n// }\n\n// Example — block writes after 11pm local:\n// if (operation === "set" && new Date().getHours() >= 23) {\n//   return "Refused: no writes after 23:00.";\n// }\n\nreturn true;',
        description:
          'Optional JavaScript body that runs at invocation time and decides whether the call may proceed. Variables in scope: <code>operation</code>, <code>thingId</code>, <code>propertyId</code>, <code>value</code> (Set only), and <code>budget</code>. Return <code>true</code>/<code>undefined</code>/<code>null</code> to allow, <code>false</code> for a generic rejection, or a string to reject with that exact message — when wired to an AI Agent the string is fed back as tool output so the LLM can self-correct. Runs without a sandbox — same trust model as the n8n Code node. Leave empty to skip.',
      },
      {
        displayName: 'Rate Limit',
        name: 'rateLimit',
        type: 'collection',
        placeholder: 'Add Rate Limit',
        default: {},
        displayOptions: { show: { resource: ['property'] } },
        description:
          'Cap how often this property may be invoked. Exceeding the limit short-circuits with a rejection string the LLM can read. Counters are in-memory per n8n process; they reset on container restart and are not shared across queue-mode workers.',
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
            displayName: 'Request Timeout (ms)',
            name: 'timeout',
            type: 'number',
            default: DEFAULT_TIMEOUT_MS,
            description:
              'Hard cap on how long to wait for the Arduino Cloud API before failing the call. Independent of Arduino Cloud\'s own rate limit.',
          },
        ],
      },
    ],
  };

  methods = {
    loadOptions: {
      async listThings(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const data = (await this.getCredentials(CREDENTIAL_NAME)) as CredentialData;
        const things = await listThings(credentialRequest(data));
        things.sort((a, b) => a.name.localeCompare(b.name));
        return things.map((t) => ({
          name: t.name,
          value: t.id,
          description: t.properties_count ? `${t.properties_count} properties` : undefined,
        }));
      },
      async listProperties(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const thingId = this.getCurrentNodeParameter('thingId') as string;
        if (!thingId) return [];
        const data = (await this.getCredentials(CREDENTIAL_NAME)) as CredentialData;
        const props = await listProperties(credentialRequest(data), thingId);
        props.sort((a, b) => a.name.localeCompare(b.name));
        return props.map((p) => ({
          name: p.name,
          value: p.id,
          description: `${p.type} · ${p.permission}`,
        }));
      },
    },
    credentialTest: {
      [CRED_TEST_FN]: testArduinoCloudCredential,
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    const credData = (await this.getCredentials(CREDENTIAL_NAME)) as CredentialData;
    const credReq = credentialRequest(credData);

    for (let i = 0; i < items.length; i++) {
      try {
        const resource = this.getNodeParameter('resource', i) as string;
        if (resource !== 'property') {
          throw new NodeOperationError(
            this.getNode(),
            `Unknown resource "${resource}". Only "property" is supported in this version.`,
            { itemIndex: i },
          );
        }
        const operation = this.getNodeParameter('operation', i) as
          | 'get'
          | 'set'
          | 'getHistory';
        const thingId = (this.getNodeParameter('thingId', i) as string).trim();
        const propertyId = (this.getNodeParameter('propertyId', i) as string).trim();
        if (!thingId || !propertyId) {
          throw new NodeOperationError(
            this.getNode(),
            'Thing and Property are required',
            { itemIndex: i },
          );
        }

        const value =
          operation === 'set' ? parseValue(this, i) : undefined;

        // Counter key includes thingId + propertyId so two nodes targeting the
        // same property share the cap (good — rate-limiting the MCU, not the
        // node), but different properties have independent budgets.
        const counterKey = `${this.getNode().id}:${thingId}:${propertyId}:${operation}`;
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
              json: { operation, thingId, propertyId, refused: true, error: msg },
              pairedItem: { item: i },
            });
            continue;
          }
        }

        const guardBody = (this.getNodeParameter('propertyGuard', i, '') as string).trim();
        if (guardBody) {
          const budget = {
            used: (window: RateLimitWindow) => countInWindow(counterKey, window),
            remaining:
              rateLimitCap !== null
                ? Math.max(0, rateLimitCap - countInWindow(counterKey, rateLimitWindow))
                : null,
            resetsInMs: rateLimitCap !== null ? resetsInMs(counterKey, rateLimitWindow) : null,
          };
          let verdict;
          try {
            verdict = runGuard(guardBody, { operation, thingId, propertyId, value, budget });
          } catch (err) {
            throw new NodeOperationError(
              this.getNode(),
              `Property guard threw: ${err instanceof Error ? err.message : String(err)}`,
              { itemIndex: i },
            );
          }
          if (!verdict.allowed) {
            returnData.push({
              json: {
                operation,
                thingId,
                propertyId,
                ...(operation === 'set' ? { value: value as IDataObject[string] } : {}),
                refused: true,
                error: verdict.message,
              },
              pairedItem: { item: i },
            });
            continue;
          }
        }

        // Record only after both gates pass — a rejected call should not
        // consume budget that a later legitimate call might need.
        recordCall(counterKey);

        if (operation === 'get') {
          const prop = await getProperty(credReq, thingId, propertyId);
          returnData.push({
            json: {
              operation,
              thingId,
              propertyId,
              name: prop.name,
              variable_name: prop.variable_name,
              type: prop.type,
              permission: prop.permission,
              last_value: prop.last_value ?? null,
              value_updated_at: prop.value_updated_at ?? null,
            },
            pairedItem: { item: i },
          });
        } else if (operation === 'set') {
          await publishProperty(credReq, thingId, propertyId, value);
          returnData.push({
            json: {
              operation,
              thingId,
              propertyId,
              value: value as IDataObject[string],
              ok: true,
            },
            pairedItem: { item: i },
          });
        } else {
          const to = readDate(this, 'to', i) ?? new Date();
          const from =
            readDate(this, 'from', i) ?? new Date(to.getTime() - DEFAULT_HISTORY_LOOKBACK_MS);
          const results = await historicData(credReq, [propertyId], from, to);
          const first = results[0];
          returnData.push({
            json: {
              operation,
              thingId,
              propertyId,
              from: from.toISOString(),
              to: to.toISOString(),
              count: first?.points.length ?? 0,
              points: first?.points ?? [],
            },
            pairedItem: { item: i },
          });
        }
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
 * Credential test — mints a fresh token (bypassing the cache) and issues one
 * cheap REST call. Landing on ArduinoCloud because Credentials -> Test
 * Connection resolves `testedBy` through any node declaring the credential.
 */
async function testArduinoCloudCredential(
  this: ICredentialTestFunctions,
  credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
  const data = credential.data as unknown as CredentialData | undefined;
  if (!data) return { status: 'Error', message: 'Credential data is empty.' };
  const req = credentialRequest(data);
  if (!req.clientId || !req.clientSecret) {
    return { status: 'Error', message: 'Client ID and Client Secret are required.' };
  }
  try {
    const { accessToken } = await fetchToken(req);
    const client = new ApiClient();
    client.authentications.oauth2.accessToken = accessToken;
    const api = new ThingsV2Api(client);
    const things = await api.thingsV2List({
      showProperties: false,
      ...(req.organizationId ? { xOrganization: req.organizationId } : {}),
    });
    return {
      status: 'OK',
      message: `Connected — ${things.length} Thing${things.length === 1 ? '' : 's'} visible`,
    };
  } catch (err) {
    return { status: 'Error', message: err instanceof Error ? err.message : String(err) };
  }
}

function parseValue(ctx: IExecuteFunctions, i: number): unknown {
  const type = ctx.getNodeParameter('valueType', i, 'auto') as
    | 'auto'
    | 'string'
    | 'number'
    | 'boolean'
    | 'json';
  const raw = ctx.getNodeParameter('value', i);

  // When the expression evaluator already returned a typed value (object,
  // number, boolean), respect it unless the user picked an explicit coercion.
  if (type === 'auto' && typeof raw !== 'string') return raw;

  switch (type) {
    case 'string':
      return raw == null ? '' : String(raw);
    case 'number': {
      if (typeof raw === 'number') return raw;
      const s = String(raw).trim();
      const n = Number(s);
      if (s === '' || Number.isNaN(n)) {
        throw new NodeOperationError(ctx.getNode(), `"${raw}" is not a valid number`, {
          itemIndex: i,
        });
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
        `"${raw}" is not a valid boolean (use true/false)`,
        { itemIndex: i },
      );
    }
    case 'json': {
      if (typeof raw !== 'string') return raw;
      try {
        return JSON.parse(raw);
      } catch (err) {
        throw new NodeOperationError(
          ctx.getNode(),
          `Value is not valid JSON: ${(err as Error).message}`,
          { itemIndex: i },
        );
      }
    }
    case 'auto':
    default: {
      const s = typeof raw === 'string' ? raw.trim() : '';
      if (s === '') return raw;
      if (s === 'true') return true;
      if (s === 'false') return false;
      // Number-ish: only if it fully parses as a number.
      if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
      // Object/array literal?
      if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
        try {
          return JSON.parse(s);
        } catch {
          return raw;
        }
      }
      return raw;
    }
  }
}

function readDate(ctx: IExecuteFunctions, name: string, i: number): Date | null {
  const v = ctx.getNodeParameter(name, i, '') as string | Date | null | undefined;
  if (v === undefined || v === null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new NodeOperationError(ctx.getNode(), `"${name}" is not a valid date: ${v}`, {
      itemIndex: i,
    });
  }
  return d;
}
