/**
 * Integration tests — run against a real arduino-router on the UNO Q.
 *
 * Two transport groups live in this package: unix, tcp, mtls. The fourth
 * (ssh) lives in packages/n8n-nodes/test/integration.test.ts because the
 * SSH transport is driven by SshServer, which is an n8n-nodes module.
 *
 * The recommended entry point is `./scripts/run-integration.sh` from the
 * repo root: it opens the unix tunnel, deploys + tears down the tcp/mtls
 * relays on the Q, sets the right env vars, and runs every variant in
 * sequence. To run a single variant manually, set only its env vars:
 *
 *   A. Unix socket — SSH-tunnel the router socket to the PC:
 *        rm -f /tmp/arduino-router.sock
 *        ssh -N -L /tmp/arduino-router.sock:/var/run/arduino-router.sock arduino@linucs.local &
 *        UNOQ_SOCKET=/tmp/arduino-router.sock npm run test:integration -w packages/bridge
 *
 *   B. TCP (Variant A relay):
 *        On the Q:  cd ~/n8n/relay && docker compose up -d
 *        UNOQ_TCP_HOST=linucs.local UNOQ_TCP_PORT=5775 \
 *          npm run test:integration -w packages/bridge
 *
 *   C. mTLS (Variant C relay) — UNOQ_TLS_HOST must match the server cert SAN
 *      (typically <device-nick>.local):
 *        UNOQ_TLS_HOST=linucs.local UNOQ_TLS_PORT=5775 \
 *          UNOQ_TLS_CA=deploy/relay-mtls/pki/out/n8n/laptop/ca.pem \
 *          UNOQ_TLS_CERT=deploy/relay-mtls/pki/out/n8n/laptop/client.pem \
 *          UNOQ_TLS_KEY=deploy/relay-mtls/pki/out/n8n/laptop/client.key \
 *          npm run test:integration -w packages/bridge
 *
 * Multiple variants can be configured simultaneously and all run in one
 * invocation — that's how the orchestrator script drives this.
 */
import { describe, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { registerSharedAssertions } from './shared-assertions.js';

// Resolve UNOQ_TLS_* paths against the directory the user actually invoked
// the command from, not against vitest's CWD. When `npm run test:integration
// -w packages/bridge` runs, npm cd's into packages/bridge first; INIT_CWD is
// npm's pre-cd directory, which is what users think of as "where I ran the
// command." Absolute paths pass through untouched.
function resolveUserPath(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), p);
}

function readCertOrExplain(varName: string, rawPath: string): string {
  const resolved = resolveUserPath(rawPath);
  try {
    return fs.readFileSync(resolved, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${varName} not found: ${resolved}\n` +
          `  Raw value: ${rawPath}\n` +
          `  Resolved against: ${process.env.INIT_CWD ?? process.cwd()}\n` +
          `  Use an absolute path or a path relative to where you ran npm.`,
      );
    }
    throw err;
  }
}

let registered = 0;

if (process.env.UNOQ_SOCKET) {
  registerSharedAssertions('unix', () => ({
    socket: process.env.UNOQ_SOCKET!,
    reconnect: { enabled: false },
  }));
  registered++;
}

if (process.env.UNOQ_TCP_HOST && process.env.UNOQ_TCP_PORT) {
  registerSharedAssertions('tcp', () => ({
    transport: {
      kind: 'tcp',
      host: process.env.UNOQ_TCP_HOST!,
      port: Number(process.env.UNOQ_TCP_PORT),
    },
    reconnect: { enabled: false },
  }));
  registered++;
}

if (
  process.env.UNOQ_TLS_HOST &&
  process.env.UNOQ_TLS_PORT &&
  process.env.UNOQ_TLS_CA &&
  process.env.UNOQ_TLS_CERT &&
  process.env.UNOQ_TLS_KEY
) {
  registerSharedAssertions('tls', () => ({
    transport: {
      kind: 'tls',
      host: process.env.UNOQ_TLS_HOST!,
      port: Number(process.env.UNOQ_TLS_PORT),
      ca: readCertOrExplain('UNOQ_TLS_CA', process.env.UNOQ_TLS_CA!),
      cert: readCertOrExplain('UNOQ_TLS_CERT', process.env.UNOQ_TLS_CERT!),
      key: readCertOrExplain('UNOQ_TLS_KEY', process.env.UNOQ_TLS_KEY!),
    },
    reconnect: { enabled: false },
  }));
  registered++;
}

if (registered === 0) {
  describe.skip('integration', () => {
    it('set UNOQ_SOCKET, UNOQ_TCP_HOST+UNOQ_TCP_PORT, or UNOQ_TLS_* to run', () => {});
  });
}
