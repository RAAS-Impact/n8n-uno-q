/**
 * transport-resolver — pick the router descriptor a node should talk to.
 *
 * Priority:
 *   1. If the node has a `unoQRouterApi` credential assigned, build the
 *      descriptor from the credential's fields and return its ID alongside.
 *   2. Otherwise fall back to the legacy per-node "Socket Path" option —
 *      emit a one-time deprecation warning. This path will be removed in
 *      the next major release.
 *
 * Each node file is bundled independently by esbuild, so this helper lives
 * under `src/` and is inlined into every bundle. No shared runtime state.
 */
import { NodeOperationError } from 'n8n-workflow';
import type { IDataObject, INode, Logger } from 'n8n-workflow';
import type { TransportDescriptor } from '@raasimpact/arduino-uno-q-bridge';

export interface UnoQRouterCredential {
  transport: 'unix' | 'tcp';
  socketPath?: string;
  host?: string;
  port?: number;
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
}

export const CREDENTIAL_NAME = 'unoQRouterApi';
const LEGACY_DEFAULT_SOCKET = '/var/run/arduino-router.sock';

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
    return { kind: 'tcp', host, port };
  }
  const path = (cred.socketPath ?? '').trim() || LEGACY_DEFAULT_SOCKET;
  return { kind: 'unix', path };
}
