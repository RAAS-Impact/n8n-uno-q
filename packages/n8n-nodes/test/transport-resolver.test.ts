/**
 * transport-resolver tests.
 *
 * Pure unit tests — no bridge, no socket. We drive resolveTransport() with a
 * fake ResolverContext and assert which descriptor is returned, whether the
 * deprecation warning fires, and that invalid credential shapes surface as
 * NodeOperationError with a useful message.
 */
import { describe, expect, it, vi } from 'vitest';
import { NodeOperationError } from 'n8n-workflow';
import {
  CREDENTIAL_NAME,
  descriptorFromCredential,
  resolveTransport,
  type UnoQRouterCredential,
} from '../src/transport-resolver.js';

const LEGACY_DEFAULT_SOCKET = '/var/run/arduino-router.sock';

function makeCtx(opts: {
  credentials?: Record<string, { id?: string }>;
  credentialData?: UnoQRouterCredential;
} = {}) {
  const warn = vi.fn();
  const getCredentials = vi.fn(async () => {
    if (!opts.credentialData) {
      throw new Error(
        'getCredentials called but no credentialData configured on the fake ctx',
      );
    }
    return opts.credentialData;
  });
  const ctx = {
    getNode: () => ({
      id: 'node-1',
      name: 'Fake Node',
      type: 'n8n-nodes-uno-q.unoQCall',
      typeVersion: 1,
      credentials: opts.credentials,
    }),
    getCredentials,
    logger: { warn, info: () => {}, debug: () => {}, error: () => {} },
  };
  // Cast through unknown — we only implement the narrow ResolverContext subset,
  // not the full IExecuteFunctions interface.
  return { ctx: ctx as unknown as Parameters<typeof resolveTransport>[0], warn, getCredentials };
}

describe('resolveTransport', () => {
  it('prefers the credential when one is assigned (unix)', async () => {
    const { ctx, warn, getCredentials } = makeCtx({
      credentials: { [CREDENTIAL_NAME]: { id: 'cred-42' } },
      credentialData: { transport: 'unix', socketPath: '/tmp/router.sock' },
    });

    const resolved = await resolveTransport(ctx, '/ignored/legacy/path.sock');

    expect(resolved).toEqual({
      descriptor: { kind: 'unix', path: '/tmp/router.sock' },
      credentialId: 'cred-42',
    });
    expect(getCredentials).toHaveBeenCalledWith(CREDENTIAL_NAME, undefined);
    expect(warn).not.toHaveBeenCalled();
  });

  it('prefers the credential when one is assigned (tcp)', async () => {
    const { ctx } = makeCtx({
      credentials: { [CREDENTIAL_NAME]: { id: 'cred-tcp' } },
      credentialData: { transport: 'tcp', host: 'kitchen.local', port: 5775 },
    });

    const resolved = await resolveTransport(ctx, undefined);

    expect(resolved).toEqual({
      descriptor: { kind: 'tcp', host: 'kitchen.local', port: 5775 },
      credentialId: 'cred-tcp',
    });
  });

  it('forwards itemIndex to getCredentials', async () => {
    const { ctx, getCredentials } = makeCtx({
      credentials: { [CREDENTIAL_NAME]: { id: 'cred-42' } },
      credentialData: { transport: 'unix', socketPath: '/tmp/r.sock' },
    });

    await resolveTransport(ctx, undefined, 7);
    expect(getCredentials).toHaveBeenCalledWith(CREDENTIAL_NAME, 7);
  });

  it('falls back to the legacy socketPath with no credential, warns on non-default values', async () => {
    const { ctx, warn } = makeCtx();

    const resolved = await resolveTransport(ctx, '/tmp/custom.sock');

    expect(resolved).toEqual({
      descriptor: { kind: 'unix', path: '/tmp/custom.sock' },
    });
    expect(resolved.credentialId).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/deprecated "Socket Path" option/);
    expect(warn.mock.calls[0][0]).toContain('Fake Node');
  });

  it('falls back silently when no credential and no legacy value is set', async () => {
    const { ctx, warn } = makeCtx();

    const resolved = await resolveTransport(ctx, undefined);

    expect(resolved.descriptor).toEqual({
      kind: 'unix',
      path: LEGACY_DEFAULT_SOCKET,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back silently when the legacy value equals the historical default', async () => {
    const { ctx, warn } = makeCtx();

    const resolved = await resolveTransport(ctx, LEGACY_DEFAULT_SOCKET);

    expect(resolved.descriptor).toEqual({
      kind: 'unix',
      path: LEGACY_DEFAULT_SOCKET,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores a credential entry that has no id (treated as unassigned)', async () => {
    const { ctx, getCredentials } = makeCtx({
      credentials: { [CREDENTIAL_NAME]: {} },
    });

    const resolved = await resolveTransport(ctx, undefined);

    expect(resolved.descriptor).toEqual({
      kind: 'unix',
      path: LEGACY_DEFAULT_SOCKET,
    });
    expect(getCredentials).not.toHaveBeenCalled();
  });
});

describe('descriptorFromCredential', () => {
  const fakeNode = { name: 'Fake Node' } as never;

  it('builds a unix descriptor from the credential path', () => {
    const d = descriptorFromCredential(fakeNode, {
      transport: 'unix',
      socketPath: '/tmp/a.sock',
    });
    expect(d).toEqual({ kind: 'unix', path: '/tmp/a.sock' });
  });

  it('defaults the unix path when the credential leaves it blank', () => {
    const d = descriptorFromCredential(fakeNode, { transport: 'unix', socketPath: '   ' });
    expect(d).toEqual({ kind: 'unix', path: LEGACY_DEFAULT_SOCKET });
  });

  it('builds a tcp descriptor and trims the host', () => {
    const d = descriptorFromCredential(fakeNode, {
      transport: 'tcp',
      host: '  kitchen.local  ',
      port: 5775,
    });
    expect(d).toEqual({ kind: 'tcp', host: 'kitchen.local', port: 5775 });
  });

  it('rejects tcp with an empty host', () => {
    expect(() =>
      descriptorFromCredential(fakeNode, { transport: 'tcp', host: '', port: 5775 }),
    ).toThrow(NodeOperationError);
  });

  it('rejects tcp with an out-of-range port', () => {
    for (const port of [0, -1, 65_536, Number.NaN]) {
      expect(() =>
        descriptorFromCredential(fakeNode, {
          transport: 'tcp',
          host: 'kitchen.local',
          port,
        }),
      ).toThrow(/invalid port/);
    }
  });

  it('rejects tcp with a missing port', () => {
    expect(() =>
      descriptorFromCredential(fakeNode, {
        transport: 'tcp',
        host: 'kitchen.local',
      } as UnoQRouterCredential),
    ).toThrow(/invalid port/);
  });
});
