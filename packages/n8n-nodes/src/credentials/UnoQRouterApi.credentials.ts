/**
 * UnoQRouterApi — credential identifying a single Arduino UNO Q router endpoint.
 *
 * One credential per Q, regardless of how n8n reaches it. The `transport`
 * field selects the path:
 *   - `unix`      — same-host unix socket (n8n on the Q itself).
 *   - `tcp`       — n8n dials the Q over TCP (Variant A plain, Variant C with mTLS).
 *   - `ssh-relay` — Q dials n8n over reverse-SSH (Variant B, NAT-friendly).
 *
 * The four transports were originally split across two credential types
 * (UnoQRouterApi + UnoQSshApi). They were merged because users only ever
 * need to answer one question — "how do I reach this Q?" — and exposing
 * two parallel credential dropdowns on every node forced the user to pick
 * one and leave the other empty. The `transport` enum + displayOptions
 * collapses that to a single dropdown per node.
 *
 * The trust models differ across transports (TCP/TLS dial-out vs SSH
 * listen-for-incoming) but that's a code-organization concern; from the
 * user's perspective it's just another row in the Transport dropdown.
 *
 * Test Connection is wired via a node method (`methods.credentialTest.
 * unoQRouterApiTest` on the UnoQCall node) — msgpack-rpc isn't HTTP, so n8n's
 * built-in `ICredentialTestRequest` doesn't apply. The node method opens a
 * Bridge with the supplied descriptor, runs `$/version`, and returns the
 * router's version string on success or a friendly error on failure.
 *
 * Multiline secrets (TLS PEMs, SSH host private key, SSH user CA pubkey)
 * use plain `string` with `password: false`. n8n's masked-multiline textarea
 * round-trips a placeholder into storage on any re-save, corrupting PEM/SSH
 * parsers. n8n encrypts credential values at rest regardless of UI masking,
 * so leaving these unmasked doesn't change security posture.
 */
import type {
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

const DEFAULT_SOCKET = '/var/run/arduino-router.sock';
const DEFAULT_TCP_PORT = 5775;
const DEFAULT_SSH_LISTEN_ADDRESS = '0.0.0.0';
const DEFAULT_SSH_LISTEN_PORT = 2222;
const DEFAULT_SSH_CONNECT_TIMEOUT_MS = 10000;

export class UnoQRouterApi implements ICredentialType {
  name = 'unoQRouterApi';
  displayName = 'Arduino UNO Q Router';
  documentationUrl =
    'https://github.com/raas-impact/n8n-uno-q/tree/main/packages/n8n-nodes#credentials';
  properties: INodeProperties[] = [
    {
      displayName:
        'This credential assumes a working router endpoint already exists. <b>Unix Socket</b> requires n8n to run on the Q itself (the default deployment shipped by this project). <b>TCP</b> requires a relay container deployed on the Q first — plain (Variant A, trusted LAN) or mTLS (Variant C, untrusted networks, needs a CA + client bundle). <b>SSH Relay</b> requires the Q to run an autossh container that dials n8n outbound — Variant B, useful for NAT-ed Qs. Setup instructions, install scripts and PKI tooling: <a href="https://github.com/raas-impact/n8n-uno-q#readme" target="_blank">github.com/raas-impact/n8n-uno-q</a>.',
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
        {
          name: 'SSH Relay (Q dials n8n — NAT-friendly)',
          value: 'ssh-relay',
          description:
            'The Q runs an autossh container that dials n8n outbound; n8n hosts an embedded SSH server that accepts the reverse tunnel. Use when the Q is behind NAT or has no public IP.',
        },
      ],
      description:
        'How n8n reaches this Q. Unix socket for same-host setups, TCP when n8n dials the Q across a network, SSH Relay when the Q dials n8n.',
    },

    // ─── Unix Socket ──────────────────────────────────────────────────────
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

    // ─── TCP (with optional mTLS) ─────────────────────────────────────────
    {
      displayName: 'Host',
      name: 'host',
      type: 'string',
      default: '',
      placeholder: '127.0.0.1  or  uno-q-kitchen.tailnet-abc.ts.net',
      displayOptions: { show: { transport: ['tcp'] } },
      description:
        'Hostname or IP of the Q exposing the relay container. Loopback for SSH-forwarded dev; a tailnet hostname or a LAN IP for production.',
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
      typeOptions: { rows: 4, password: false },
      default: '',
      displayOptions: { show: { transport: ['tcp'], useTls: [true] } },
      description:
        'Paste the contents of client.key from your n8n client bundle. This is the private key matching the Client Certificate above. Stored encrypted by n8n regardless of the in-form display.',
      required: true,
    },

    // ─── SSH Relay (Variant B) ────────────────────────────────────────────
    {
      displayName: 'Device Nickname',
      name: 'deviceNick',
      type: 'string',
      default: '',
      placeholder: 'kitchen',
      displayOptions: { show: { transport: ['ssh-relay'] } },
      description:
        'Routing key on the n8n side. Must match the <code>&lt;nick&gt;</code> you passed to <code>./pki/pki add device &lt;nick&gt;</code> — that nickname is stamped into the cert\'s KeyID and is what the embedded SSH server uses to find this Q in the registry.',
      required: true,
    },
    {
      displayName: 'Listen Address',
      name: 'listenAddress',
      type: 'string',
      default: DEFAULT_SSH_LISTEN_ADDRESS,
      displayOptions: { show: { transport: ['ssh-relay'] } },
      description:
        'Where the embedded SSH server binds. <code>0.0.0.0</code> for direct exposure, <code>127.0.0.1</code> if you front it with a reverse proxy. Same value across every credential pointing at this n8n endpoint.',
    },
    {
      displayName: 'Listen Port',
      name: 'listenPort',
      type: 'number',
      default: DEFAULT_SSH_LISTEN_PORT,
      displayOptions: { show: { transport: ['ssh-relay'] } },
      description:
        'TCP port the embedded SSH server binds. Must be reachable from every Q this n8n instance hosts.',
    },
    {
      displayName: 'Host Private Key',
      name: 'hostPrivateKey',
      type: 'string',
      typeOptions: { rows: 8, password: false },
      default: '',
      displayOptions: { show: { transport: ['ssh-relay'] } },
      description:
        'Paste the contents of <code>ssh_host_ed25519_key</code> from your n8n bundle (<code>deploy/relay-ssh/pki/out/n8n/&lt;nick&gt;/</code>). The bare ed25519 key the SSH server presents during KEX. <b>No host certificate</b> by design — devices verify the n8n endpoint via known_hosts fingerprint pinning. Stored encrypted by n8n regardless of the in-form display.',
      required: true,
    },
    {
      displayName: 'User CA Public Key',
      name: 'userCaPublicKey',
      type: 'string',
      typeOptions: { rows: 2, password: false },
      default: '',
      placeholder: 'ssh-ed25519 AAAAC3Nz... uno-q-relay-ssh user CA',
      displayOptions: { show: { transport: ['ssh-relay'] } },
      description:
        'Paste the contents of <code>user_ca.pub</code> from your n8n bundle. Public key of the CA that signs every device user cert; the embedded SSH server verifies device certs against this.',
      required: true,
    },
    {
      displayName: 'Connect Timeout (ms)',
      name: 'connectTimeoutMs',
      type: 'number',
      default: DEFAULT_SSH_CONNECT_TIMEOUT_MS,
      displayOptions: { show: { transport: ['ssh-relay'] } },
      description:
        'How long the bridge waits for this device to appear in the registry when a node tries to dial it. The Q\'s autossh may be reconnecting after a network blip — a short wait avoids spurious "device not connected" errors.',
    },
  ];
}
