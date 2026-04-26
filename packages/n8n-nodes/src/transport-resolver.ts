/**
 * transport-resolver — pick the router descriptor a node should talk to.
 *
 * One credential type, one assignment per node. The credential's
 * `transport` field decides which descriptor shape to build:
 *
 *   - `unix`      — same-host unix socket (default).
 *   - `tcp`       — n8n dials the Q over TCP, optionally with mTLS (Variant C).
 *   - `ssh-relay` — Q dials n8n over reverse-SSH (Variant B); the resolver
 *                   surfaces the SSH-specific fields (host private key, user
 *                   CA pubkey, listen address/port, timeout) on `sshCredential`
 *                   so BridgeManager can boot the singleton SshServer.
 *
 * If no credential is assigned, fall back to the legacy per-node "Socket
 * Path" option and emit a one-time deprecation warning.
 *
 * Each node file is bundled independently by esbuild, so this helper lives
 * under `src/` and is inlined into every bundle. No shared runtime state.
 */
import { NodeOperationError } from 'n8n-workflow';
import type { IDataObject, INode, Logger } from 'n8n-workflow';
import type { TransportDescriptor } from '@raasimpact/arduino-uno-q-bridge';

export type UnoQTransportMode = 'unix' | 'tcp' | 'ssh-relay';

export interface UnoQRouterCredential {
  transport: UnoQTransportMode;
  // Unix
  socketPath?: string;
  // TCP / TLS
  host?: string;
  port?: number;
  /** mTLS mode (Variant C). When true, caCert/clientCert/clientKey must all be populated. */
  useTls?: boolean;
  caCert?: string;
  clientCert?: string;
  clientKey?: string;
  // SSH Relay (Variant B)
  deviceNick?: string;
  listenAddress?: string;
  listenPort?: number;
  hostPrivateKey?: string;
  userCaPublicKey?: string;
  connectTimeoutMs?: number;
}

/**
 * The principal n8n requires on every accepted device user cert. The
 * shipped PKI hard-codes this value and exposes no override flag, so
 * making it credential-configurable would only let users break their
 * own setup. If a future fork mints with a different principal, change
 * this constant and rebuild.
 */
export const SSH_REQUIRED_PRINCIPAL = 'tunnel';

/**
 * Resolved SSH credential — the SSH-specific subset of the credential
 * payload with defaults applied (every field non-undefined) and the
 * pinned principal injected. Consumers (BridgeManager → SshServer) treat
 * this as the source of truth.
 */
export interface ResolvedSshCredential {
  deviceNick: string;
  listenAddress: string;
  listenPort: number;
  hostPrivateKey: string;
  userCaPublicKey: string;
  connectTimeoutMs: number;
  requiredPrincipal: string;
}

interface ResolverContext {
  getNode(): INode;
  getCredentials<T extends object = IDataObject>(type: string, itemIndex?: number): Promise<T>;
  logger: Logger;
}

export interface ResolvedTransport {
  descriptor: TransportDescriptor;
  /** Credential ID, or undefined if resolved from the legacy socketPath option. */
  credentialId?: string;
  /**
   * Present only when descriptor.kind === 'ssh' — the SSH-specific subset
   * of the credential payload with defaults applied and the pinned
   * principal injected. The SSH transport needs the host private key +
   * user CA pubkey to boot the SshServer singleton; passing them through
   * the resolver keeps the credential-fetch responsibility on this layer
   * rather than pushing it into BridgeManager.
   */
  sshCredential?: ResolvedSshCredential;
}

export const CREDENTIAL_NAME = 'unoQRouterApi';
const LEGACY_DEFAULT_SOCKET = '/var/run/arduino-router.sock';
const SSH_DEFAULT_LISTEN_ADDRESS = '0.0.0.0';
const SSH_DEFAULT_LISTEN_PORT = 2222;
const SSH_DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export async function resolveTransport(
  ctx: ResolverContext,
  legacySocketPath: string | undefined,
  itemIndex?: number,
): Promise<ResolvedTransport> {
  const node = ctx.getNode();
  const credRef = node.credentials?.[CREDENTIAL_NAME];
  if (credRef?.id) {
    const cred = (await ctx.getCredentials<UnoQRouterCredential>(
      CREDENTIAL_NAME,
      itemIndex,
    )) as UnoQRouterCredential;

    if (cred.transport === 'ssh-relay') {
      const validated = validateSshCredential(node, cred);
      return {
        descriptor: {
          kind: 'ssh',
          listenAddress: validated.listenAddress,
          listenPort: validated.listenPort,
          deviceNick: validated.deviceNick,
        },
        credentialId: credRef.id,
        sshCredential: validated,
      };
    }

    return {
      descriptor: descriptorFromCredential(node, cred),
      credentialId: credRef.id,
    };
  }

  // Legacy path. Warn only when the user set a non-default value — the
  // default is what every pre-credential workflow also had, so warning on
  // the default would be noise rather than signal.
  if (legacySocketPath && legacySocketPath !== LEGACY_DEFAULT_SOCKET) {
    ctx.logger.warn(
      `Arduino UNO Q node "${node.name}" is using the deprecated "Socket Path" option. ` +
        `Create an "Arduino UNO Q Router" credential and assign it to the node instead — ` +
        `the socket path option will be removed in the next major release.`,
    );
  }
  return {
    descriptor: { kind: 'unix', path: legacySocketPath || LEGACY_DEFAULT_SOCKET },
  };
}

/**
 * Validate the SSH-relay subset of the credential and fill in defaults.
 * Throws if a required field is empty.
 */
function validateSshCredential(node: INode, cred: UnoQRouterCredential): ResolvedSshCredential {
  const deviceNick = (cred.deviceNick ?? '').trim();
  if (!deviceNick) {
    throw new NodeOperationError(node, 'Credential has transport=ssh-relay but "Device Nickname" is empty.');
  }
  const hostPrivateKey = (cred.hostPrivateKey ?? '').trim();
  if (!hostPrivateKey) {
    throw new NodeOperationError(
      node,
      'Credential has transport=ssh-relay but "Host Private Key" is empty. Paste the contents of pki/out/n8n/<nick>/ssh_host_ed25519_key.',
    );
  }
  const userCaPublicKey = (cred.userCaPublicKey ?? '').trim();
  if (!userCaPublicKey) {
    throw new NodeOperationError(
      node,
      'Credential has transport=ssh-relay but "User CA Public Key" is empty. Paste the contents of pki/out/n8n/<nick>/user_ca.pub.',
    );
  }
  const listenAddress = (cred.listenAddress ?? '').trim() || SSH_DEFAULT_LISTEN_ADDRESS;
  const listenPort = Number(cred.listenPort);
  const finalListenPort =
    Number.isFinite(listenPort) && listenPort > 0 && listenPort <= 65_535
      ? listenPort
      : SSH_DEFAULT_LISTEN_PORT;
  const connectTimeoutMs = Number(cred.connectTimeoutMs);
  const finalTimeoutMs =
    Number.isFinite(connectTimeoutMs) && connectTimeoutMs > 0
      ? connectTimeoutMs
      : SSH_DEFAULT_CONNECT_TIMEOUT_MS;
  return {
    deviceNick,
    listenAddress,
    listenPort: finalListenPort,
    hostPrivateKey,
    userCaPublicKey,
    requiredPrincipal: SSH_REQUIRED_PRINCIPAL,
    connectTimeoutMs: finalTimeoutMs,
  };
}

export function descriptorFromCredential(
  node: INode,
  cred: UnoQRouterCredential,
): TransportDescriptor {
  if (cred.transport === 'tcp') {
    const host = (cred.host ?? '').trim();
    const port = Number(cred.port);
    if (!host) {
      throw new NodeOperationError(
        node,
        `Credential has transport=tcp but no host configured.`,
      );
    }
    if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
      throw new NodeOperationError(
        node,
        `Credential has invalid port ${cred.port ?? '(empty)'}; expected 1–65535.`,
      );
    }
    if (cred.useTls) {
      // With `displayOptions` the three fields are shown as required when the
      // toggle is on, so n8n should prevent saving an incomplete credential.
      // We re-check here anyway because a credential edited via the REST API
      // could bypass the form (and the resulting connect() error would be
      // opaque otherwise).
      const ca = (cred.caCert ?? '').trim();
      const cert = (cred.clientCert ?? '').trim();
      const key = (cred.clientKey ?? '').trim();
      const missing: string[] = [];
      if (!ca) missing.push('CA Certificate');
      if (!cert) missing.push('Client Certificate');
      if (!key) missing.push('Client Key');
      if (missing.length) {
        throw new NodeOperationError(
          node,
          `Credential has "Use TLS" on but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} empty. Paste the PEM contents from your n8n client bundle (deploy/relay-mtls/pki/out/n8n/<nick>/).`,
        );
      }
      return { kind: 'tls', host, port, ca, cert, key };
    }
    return { kind: 'tcp', host, port };
  }
  const path = (cred.socketPath ?? '').trim() || LEGACY_DEFAULT_SOCKET;
  return { kind: 'unix', path };
}
