/**
 * ArduinoCloudTrigger — fire a workflow on property-value updates, delivered
 * by `arduino-iot-js` over MQTT-over-WebSocket.
 *
 * v1 is MQTT-only. No polling, no webhook. The SDK manages reconnect and
 * token refresh internally; we just hand it the credentials and the
 * (thingId, variableName) to subscribe to. Multiple triggers on the same
 * credential share one MQTT connection through CloudClientManager (see
 * ./cloudClientManager.ts for why this isn't one-client-per-node).
 *
 * The SDK subscribes by the property's **variable_name** (not its UUID), so
 * the Property picker for this node differs from the action node's — we
 * return variable_name as the option value.
 */
import {
  NodeOperationError,
  type IDataObject,
  type ILoadOptionsFunctions,
  type INodePropertyOptions,
  type INodeType,
  type INodeTypeDescription,
  type ITriggerFunctions,
  type ITriggerResponse,
} from 'n8n-workflow';
import { listProperties, listThings } from '../../arduinoCloudApi.js';
import { CloudClientManager, type CloudCredential } from '../../cloudClientManager.js';
import type { TokenRequest } from '../../auth/tokenCache.js';

const CREDENTIAL_NAME = 'arduinoCloudOAuth2Api';

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

function cloudCredential(data: CredentialData): CloudCredential {
  return {
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    organizationId: data.organizationId?.trim() || undefined,
  };
}

export class ArduinoCloudTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Arduino Cloud Trigger',
    name: 'arduinoCloudTrigger',
    icon: 'file:arduinoCloudTrigger.svg',
    group: ['trigger'],
    version: 1,
    description:
      'Fire a workflow on property-value updates from an Arduino Cloud Thing',
    defaults: { name: 'Arduino Cloud Trigger' },
    codex: {
      alias: ['Arduino', 'Cloud', 'IoT', 'Thing', 'Property', 'MQTT', 'realtime'],
    },
    inputs: [],
    outputs: ['main'],
    credentials: [
      {
        name: CREDENTIAL_NAME,
        required: true,
        testedBy: 'arduinoCloudOAuth2ApiTest',
      },
    ],
    properties: [
      {
        displayName: 'Thing Name or ID',
        name: 'thingId',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'listThings' },
        default: '',
        required: true,
        description:
          'The Thing whose property to subscribe to. Choose from the list, or use an <a href="https://docs.n8n.io/code-examples/expressions/">expression</a>.',
      },
      {
        displayName: 'Property Variable Name',
        name: 'variableName',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'listPropertyVarNames',
          loadOptionsDependsOn: ['thingId'],
        },
        default: '',
        required: true,
        description:
          'The property\'s variable name (as declared in the sketch, e.g. "temperature"). Loaded from the Thing above. The MQTT SDK subscribes by variable name, not the property UUID.',
      },
    ],
  };

  methods = {
    loadOptions: {
      async listThings(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const data = (await this.getCredentials(CREDENTIAL_NAME)) as CredentialData;
        const things = await listThings(credentialRequest(data));
        things.sort((a, b) => a.name.localeCompare(b.name));
        return things.map((t) => ({ name: t.name, value: t.id }));
      },
      async listPropertyVarNames(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        const thingId = this.getCurrentNodeParameter('thingId') as string;
        if (!thingId) return [];
        const data = (await this.getCredentials(CREDENTIAL_NAME)) as CredentialData;
        const props = await listProperties(credentialRequest(data), thingId);
        props.sort((a, b) => a.name.localeCompare(b.name));
        return props.map((p) => ({
          name: `${p.name} (${p.variable_name})`,
          value: p.variable_name,
          description: `${p.type} · ${p.permission}`,
        }));
      },
    },
  };

  async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
    const thingId = (this.getNodeParameter('thingId') as string).trim();
    const variableName = (this.getNodeParameter('variableName') as string).trim();
    if (!thingId) {
      throw new NodeOperationError(this.getNode(), 'Thing is required');
    }
    if (!variableName) {
      throw new NodeOperationError(this.getNode(), 'Property Variable Name is required');
    }

    const data = (await this.getCredentials(CREDENTIAL_NAME)) as CredentialData;
    const credRef = this.getNode().credentials?.[CREDENTIAL_NAME];
    const credentialKey = credRef?.id ?? `${data.clientId}\0${data.organizationId ?? ''}`;
    const cred = cloudCredential(data);

    const manager = CloudClientManager.getInstance();

    const handler = (value: unknown) => {
      const payload: IDataObject = {
        thingId,
        variableName,
        value: value as IDataObject[string],
        receivedAt: new Date().toISOString(),
      };
      this.emit([this.helpers.returnJsonArray([payload])]);
    };

    const unsubscribe = await manager.subscribe(
      credentialKey,
      cred,
      thingId,
      variableName,
      handler,
    );

    const closeFunction = async () => {
      await unsubscribe();
    };

    return { closeFunction };
  }
}
