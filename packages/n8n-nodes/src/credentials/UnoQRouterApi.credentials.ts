/**
 * UnoQRouterApi — credential identifying a single Arduino UNO Q router endpoint.
 *
 * The credential describes *where* to reach a router (unix socket or TCP host+
 * port) and lets a single n8n workflow drive multiple Qs by assigning a
 * different credential to each node. See docs/master-plan/12-multi-q.md §12.4 for the full design.
 *
 * Test Connection is wired via a node method (`methods.credentialTest.
 * unoQRouterApiTest` on the UnoQCall node) — msgpack-rpc isn't HTTP, so n8n's
 * built-in `ICredentialTestRequest` doesn't apply. The node method opens a
 * Bridge with the supplied descriptor, runs `$/version`, and returns the
 * router's version string on success or a friendly error on failure.
 */
import type {
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

const DEFAULT_SOCKET = '/var/run/arduino-router.sock';
const DEFAULT_TCP_PORT = 5775;

export class UnoQRouterApi implements ICredentialType {
  name = 'unoQRouterApi';
  displayName = 'Arduino UNO Q Router';
  documentationUrl =
    'https://github.com/raas-impact/n8n-uno-q/tree/main/packages/n8n-nodes#credentials';
  properties: INodeProperties[] = [
    {
      displayName:
        'This credential assumes a working router endpoint already exists. <b>Unix Socket</b> requires n8n to run on the Q itself (the default deployment shipped by this project). <b>TCP</b> requires a relay container deployed on the Q first — plain (Variant A, trusted LAN) or mTLS (Variant C, untrusted networks, needs a CA + client bundle). Setup instructions, install scripts and PKI tooling: <a href="https://github.com/raas-impact/n8n-uno-q#readme" target="_blank">github.com/raas-impact/n8n-uno-q</a>.',
      name: 'setupNotice',
      type: 'notice',
      default: '',
    },
    {
      displayName: 'Transport',
      name: 'transport',
      type: 'options',
      default: 'unix',
      options: [
        {
          name: 'Unix Socket (local)',
          value: 'unix',
          description:
            'Connect to the router on the same host as n8n. Standard setup when n8n runs on the Q.',
        },
        {
          name: 'TCP (remote — relay container, Tailscale, LAN)',
          value: 'tcp',
          description:
            'Connect to a Q across the network via its relay container.',
        },
      ],
      description:
        'How n8n reaches this Q. Unix socket for same-host setups, TCP when n8n and the Q are on different machines.',
    },
    {
      displayName: 'Socket Path',
      name: 'socketPath',
      type: 'string',
      default: DEFAULT_SOCKET,
      placeholder: DEFAULT_SOCKET,
      displayOptions: { show: { transport: ['unix'] } },
      description:
        'Path to the arduino-router unix socket. The default is the standard location when running n8n on the Q itself; override only for non-standard deployments or SSH-tunneled dev setups (e.g. /tmp/arduino-router.sock).',
    },
    {
      displayName: 'Host',
      name: 'host',
      type: 'string',
      default: '',
      placeholder: '127.0.0.1  or  uno-q-kitchen.tailnet-abc.ts.net',
      displayOptions: { show: { transport: ['tcp'] } },
      description:
        'Hostname or IP of the Q exposing the relay container. Loopback for SSH-forwarded dev; a tailnet hostname (Variant B) or a LAN IP (Variant A) for production.',
      required: true,
    },
    {
      displayName: 'Port',
      name: 'port',
      type: 'number',
      default: DEFAULT_TCP_PORT,
      displayOptions: { show: { transport: ['tcp'] } },
      description:
        'TCP port of the relay container. Default 5775 matches deploy/relay/q/docker-compose.yml.',
      required: true,
    },
    {
      displayName: 'Use TLS (mTLS)',
      name: 'useTls',
      type: 'boolean',
      default: false,
      displayOptions: { show: { transport: ['tcp'] } },
      description:
        'Enable when connecting to a Variant C (mTLS) relay — see deploy/relay-mtls/. Requires a client certificate signed by the same CA that signed the relay\'s server cert. Leave off for Variant A (plaintext) relays on trusted LANs.',
    },
    {
      displayName: 'CA Certificate (PEM)',
      name: 'caCert',
      type: 'string',
      typeOptions: { rows: 4, password: false },
      default: '',
      displayOptions: { show: { transport: ['tcp'], useTls: [true] } },
      description:
        'Paste the contents of ca.pem from your n8n client bundle (deploy/relay-mtls/pki/out/n8n/<nick>/ca.pem). This is the CA that signed the Q\'s server cert — n8n uses it to verify you\'re talking to the right Q.',
      required: true,
    },
    {
      displayName: 'Client Certificate (PEM)',
      name: 'clientCert',
      type: 'string',
      typeOptions: { rows: 4, password: false },
      default: '',
      displayOptions: { show: { transport: ['tcp'], useTls: [true] } },
      description:
        'Paste the contents of client.pem from your n8n client bundle. This is the cert n8n presents to the relay so the relay can verify n8n is authorised.',
      required: true,
    },
    {
      displayName: 'Client Key (PEM)',
      name: 'clientKey',
      type: 'string',
      // NOT `password: true`. n8n's masked textareas round-trip the masked
      // placeholder back into storage on any credential re-save — with
      // multi-line PEM the re-save corrupts the key and OpenSSL rejects it as
      // "DECODER routines::unsupported" on the next TLS connect. n8n encrypts
      // credential values at rest regardless of UI masking, so leaving this
      // unmasked doesn't change security posture — only the in-form display
      // during editing. Matches caCert / clientCert above.
      typeOptions: { rows: 4, password: false },
      default: '',
      displayOptions: { show: { transport: ['tcp'], useTls: [true] } },
      description:
        'Paste the contents of client.key from your n8n client bundle. This is the private key matching the Client Certificate above. Stored encrypted by n8n regardless of the in-form display.',
      required: true,
    },
  ];
}
