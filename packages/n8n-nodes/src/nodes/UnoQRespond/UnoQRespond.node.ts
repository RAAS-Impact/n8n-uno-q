import {
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
} from 'n8n-workflow';
import { PendingRequests } from '../../PendingRequests.js';

type RespondWith = 'incomingItem' | 'json' | 'text' | 'error';

interface RespondOptions {
  metadataField?: string;
  stripMetadata?: boolean;
}

const DEFAULT_METADATA_FIELD = '_unoQRequest';

export class UnoQRespond implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Arduino UNO Q Respond',
    name: 'unoQRespond',
    icon: 'file:unoQRespond.svg',
    group: ['transform'],
    version: 1,
    description:
      'Send a response back to the MCU for an Arduino UNO Q Trigger in Wait for Respond Node mode',
    defaults: { name: 'Arduino UNO Q Respond' },
    codex: {
      alias: ['Arduino', 'UNO Q', 'MCU', 'microcontroller', 'router', 'bridge', 'respond'],
    },
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName:
          'Closes the open MessagePack-RPC request that an upstream Arduino UNO Q Trigger opened in "Wait for Respond Node" mode. The request is identified by the <code>_unoQRequest.msgid</code> envelope carried by the incoming item.',
        name: 'notice',
        type: 'notice',
        default: '',
      },
      {
        displayName: 'Respond With',
        name: 'respondWith',
        type: 'options',
        default: 'incomingItem',
        options: [
          {
            name: 'First Incoming Item',
            value: 'incomingItem',
            description:
              'Send the incoming item JSON back to the MCU (stripped of the _unoQRequest envelope by default).',
          },
          {
            name: 'JSON',
            value: 'json',
            description: 'Send a value parsed from a JSON expression.',
          },
          {
            name: 'Text',
            value: 'text',
            description: 'Send a plain string.',
          },
          {
            name: 'Error',
            value: 'error',
            description: 'Reject the call so the MCU-side Bridge.call() sees an error.',
          },
        ],
      },
      {
        displayName: 'Response (JSON)',
        name: 'responseJson',
        type: 'json',
        default: '{}',
        displayOptions: { show: { respondWith: ['json'] } },
        description:
          'Any JSON value (object, array, number, boolean, null, string). Sent as-is to the MCU.',
      },
      {
        displayName: 'Response Text',
        name: 'responseText',
        type: 'string',
        default: '',
        displayOptions: { show: { respondWith: ['text'] } },
      },
      {
        displayName: 'Error Message',
        name: 'errorMessage',
        type: 'string',
        default: 'Workflow rejected the request',
        displayOptions: { show: { respondWith: ['error'] } },
        description: 'Message the MCU-side Bridge.call() will receive as its error.',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        options: [
          {
            displayName: 'Metadata Field',
            name: 'metadataField',
            type: 'string',
            default: DEFAULT_METADATA_FIELD,
            description:
              'Top-level field that carries the request envelope. Matches the Trigger default unless you renamed it upstream.',
          },
          {
            displayName: 'Strip Metadata From Response',
            name: 'stripMetadata',
            type: 'boolean',
            default: true,
            displayOptions: { show: { '/respondWith': ['incomingItem'] } },
            description:
              'Remove the envelope field from the item before sending, so the MCU only sees workflow-produced data.',
          },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];
    const pending = PendingRequests.getInstance();

    for (let i = 0; i < items.length; i++) {
      try {
        const respondWith = this.getNodeParameter('respondWith', i) as RespondWith;
        const options = this.getNodeParameter('options', i, {}) as RespondOptions;
        const metadataField = options.metadataField || DEFAULT_METADATA_FIELD;

        const item = items[i].json as IDataObject;
        const envelope = item[metadataField] as IDataObject | undefined;
        const msgid = coerceMsgid(envelope?.msgid);

        if (msgid === undefined) {
          throw new NodeOperationError(
            this.getNode(),
            `Incoming item is missing "${metadataField}.msgid". Connect this node after an Arduino UNO Q Trigger running in "Wait for Respond Node" mode.`,
            { itemIndex: i },
          );
        }

        const entry = pending.take(msgid);
        if (!entry) {
          throw new NodeOperationError(
            this.getNode(),
            `No pending request for msgid ${msgid}. The MessagePack-RPC request is no longer open — it may have timed out, already been answered, or the Trigger never fired for this execution. ` +
              `This commonly happens when n8n replays pinned trigger output (manual "Execute Workflow" / re-running a single node): the Trigger's live handler is skipped, so no entry is registered in PendingRequests. ` +
              `To test end-to-end, use "Listen for test event" on the Trigger (or activate the workflow) and send a fresh Bridge.call() from the MCU.`,
            { itemIndex: i },
          );
        }
        clearTimeout(entry.timer);

        if (respondWith === 'error') {
          const message = (this.getNodeParameter('errorMessage', i) as string) || 'error';
          entry.reject(new Error(message));
          returnData.push({
            json: { msgid, responded: false, error: message },
            pairedItem: { item: i },
          });
          continue;
        }

        const value = resolveValue(this, respondWith, i, item, metadataField, options);
        entry.resolve(value);
        returnData.push({
          json: { msgid, responded: true, value: (value ?? null) as never },
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

function coerceMsgid(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function resolveValue(
  ctx: IExecuteFunctions,
  respondWith: Exclude<RespondWith, 'error'>,
  i: number,
  item: IDataObject,
  metadataField: string,
  options: RespondOptions,
): unknown {
  if (respondWith === 'text') {
    return ctx.getNodeParameter('responseText', i, '') as string;
  }

  if (respondWith === 'json') {
    const raw = ctx.getNodeParameter('responseJson', i, '{}') as unknown;
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new NodeOperationError(
        ctx.getNode(),
        `Response (JSON) is not valid JSON: ${(err as Error).message}`,
        { itemIndex: i },
      );
    }
  }

  const strip = options.stripMetadata ?? true;
  if (!strip) return item;
  const { [metadataField]: _omit, ...rest } = item;
  return rest;
}
