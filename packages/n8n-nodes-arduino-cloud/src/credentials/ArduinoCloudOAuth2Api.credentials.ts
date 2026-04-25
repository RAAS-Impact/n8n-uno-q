/**
 * ArduinoCloudOAuth2Api — credential for authenticating against the Arduino
 * Cloud API (`api2.arduino.cc`).
 *
 * Arduino Cloud uses the OAuth2 client-credentials grant. The user creates
 * an API Key in their Arduino Cloud account (Space settings → API keys),
 * which yields a Client ID + Client Secret pair. The optional Organization
 * ID selects a specific org space when the key has access to more than one.
 *
 * Same credential is consumed by two distinct transport stacks:
 *
 *   - `@arduino/arduino-iot-client` (REST) — we fetch a bearer token via the
 *     shared tokenCache and install it on `ApiClient.authentications.oauth2`.
 *
 *   - `arduino-iot-js` (realtime MQTT-over-WSS) — we hand it `clientId` and
 *     `clientSecret` directly; the SDK runs its own token flow internally.
 *
 * Test Connection is implemented as a node method on the ArduinoCloud node
 * (`methods.credentialTest.arduinoCloudOAuth2ApiTest`) because the OAuth2
 * flow isn't expressible as n8n's built-in `ICredentialTestRequest` shape.
 */
import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class ArduinoCloudOAuth2Api implements ICredentialType {
  name = 'arduinoCloudOAuth2Api';
  displayName = 'Arduino Cloud API';
  documentationUrl =
    'https://github.com/raas-impact/n8n-uno-q/tree/main/packages/n8n-nodes-arduino-cloud#credentials';
  properties: INodeProperties[] = [
    {
      displayName: 'Client ID',
      name: 'clientId',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'e.g. 4xQxXxXxXxXxXxXxXxXxXxXxXxXxXxXx',
      description:
        'Client ID of an Arduino Cloud API key. Create one under Space settings → API keys → Create API key.',
    },
    {
      displayName: 'Client Secret',
      name: 'clientSecret',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description:
        'Client Secret paired with the Client ID above. Shown only once at API-key creation time in the Arduino Cloud UI — store it in a safe place or re-generate the key.',
    },
    {
      displayName: 'Organization ID',
      name: 'organizationId',
      type: 'string',
      default: '',
      placeholder: 'Leave empty for personal space',
      description:
        'Optional. Set when the API key belongs to a multi-org account and you want calls to target a specific organisation space. Passed as the X-Organization header on REST calls and as organization_id on the token request.',
    },
  ];
}
