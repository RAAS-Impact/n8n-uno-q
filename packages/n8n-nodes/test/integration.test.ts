/**
 * Integration tests — SSH-relay variant.
 *
 * The bridge package owns the unix/tcp/mtls integration suite. This file
 * adds the fourth transport — reverse-SSH — which can't live in the
 * bridge package because it depends on SshServer (an n8n-nodes module).
 *
 * Topology:
 *
 *   Bridge (these tests)
 *     → SshTransport (bridge package)
 *     → SshServer.forwardOut on a free localhost port (n8n-side singleton)
 *     → ssh -R channel back to a system `ssh` spawned by this file
 *       (the Q-side autossh stand-in — see master-plan §14, options
 *       considered when designing the integration suite for 0.4.0)
 *     → /tmp/arduino-router.sock (existing tunnel from PC to the Q router)
 *     → arduino@<host>:/var/run/arduino-router.sock (real router)
 *
 * Why the spawn-ssh stand-in instead of the real Q-side autossh container?
 * The Q-side container is autossh + a 100-line entrypoint.sh — well-tested
 * by simply running it and watching logs. The novel 0.4.0 code is on the
 * n8n side: SshServer auth, sshCertParser, registry routing, forwardOut,
 * SshTransport, Bridge wire over a Duplex. All of that is exercised here.
 *
 * Pre-requisites (the orchestrator script handles these):
 *   - PKI material under deploy/relay-ssh/pki/{ca,out} — `./pki setup`,
 *     `./pki add n8n laptop`, `./pki add device linucs`.
 *   - /tmp/arduino-router.sock present (SSH tunnel to the Q router).
 *   - UNOQ_SOCKET=/tmp/arduino-router.sock in env.
 *
 * Manual invocation (skip the orchestrator):
 *   rm -f /tmp/arduino-router.sock
 *   ssh -N -L /tmp/arduino-router.sock:/var/run/arduino-router.sock arduino@linucs.local &
 *   UNOQ_SOCKET=/tmp/arduino-router.sock \
 *     npm run test:integration -w packages/n8n-nodes
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { SshTransport } from '../../bridge/src/index.js';
import { SshServer } from '../src/SshServer.js';
import { registerSharedAssertions } from '../../bridge/test/shared-assertions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const PKI = path.join(REPO, 'deploy/relay-ssh/pki');
const N8N_NICK = process.env.UNOQ_SSH_N8N ?? 'laptop';
const DEV_NICK = process.env.UNOQ_SSH_DEVICE ?? 'linucs';

const SOCKET = process.env.UNOQ_SOCKET;

if (!SOCKET) {
  describe.skip('integration / ssh-relay', () => {
    it('set UNOQ_SOCKET=/tmp/arduino-router.sock to run', () => {});
  });
} else {
  let sshProc: ChildProcess | undefined;
  let knownHostsPath: string | undefined;
  let server: SshServer | undefined;
  const REMOTE_BIND_PORT = 7000; // arbitrary; not used as routing key

  beforeAll(async () => {
    const n8nBundle = path.join(PKI, 'out/n8n', N8N_NICK);
    const devBundle = path.join(PKI, 'out/devices', DEV_NICK);

    const hostKey = readFileSync(path.join(n8nBundle, 'ssh_host_ed25519_key'));
    const userCaPub = readFileSync(path.join(n8nBundle, 'user_ca.pub'), 'utf8');
    const hostPub = readFileSync(path.join(n8nBundle, 'ssh_host_ed25519_key.pub'), 'utf8').trim();
    const devKey = path.join(devBundle, 'id_ed25519');
    const devCert = path.join(devBundle, 'id_ed25519-cert.pub');

    const port = await freePort();
    server = SshServer.getInstance();
    await server.listen({
      listenAddress: '127.0.0.1',
      listenPort: port,
      hostPrivateKey: hostKey,
      userCaPublicKey: userCaPub,
      requiredPrincipal: 'tunnel',
      connectTimeoutMs: 5000,
    });

    knownHostsPath = path.join(REPO, 'experiments', `.kh-integration-${process.pid}-${Date.now()}`);
    writeFileSync(knownHostsPath, `[127.0.0.1]:${port} ${hostPub}\n`);

    sshProc = spawn(
      'ssh',
      [
        '-o', 'StrictHostKeyChecking=yes',
        '-o', `UserKnownHostsFile=${knownHostsPath}`,
        '-o', 'GlobalKnownHostsFile=/dev/null',
        '-o', 'PreferredAuthentications=publickey',
        '-i', devKey,
        '-o', `CertificateFile=${devCert}`,
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ConnectTimeout=5',
        '-o', 'ServerAliveInterval=10',
        '-N',
        '-p', String(port),
        '-R', `127.0.0.1:${REMOTE_BIND_PORT}:${SOCKET}`,
        'tunnel@127.0.0.1',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let sshErr = '';
    sshProc.stderr?.on('data', (d: Buffer) => (sshErr += d.toString()));

    // Wait until the registry sees the device.
    const start = Date.now();
    while (!server._peekRegistry().has(DEV_NICK)) {
      if (Date.now() - start > 8000) {
        throw new Error(`device '${DEV_NICK}' did not register within 8s\nssh stderr:\n${sshErr}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  afterAll(async () => {
    sshProc?.kill();
    await server?.close();
    if (knownHostsPath) {
      try {
        unlinkSync(knownHostsPath);
      } catch {
        /* ignore — best-effort cleanup */
      }
    }
  });

  // Each call rebuilds an SshTransport so every Bridge gets a fresh
  // forwardOut channel on the shared SSH session.
  registerSharedAssertions('ssh', () => ({
    transportInstance: new SshTransport({
      connect: () => server!.connect(DEV_NICK),
    }),
    reconnect: { enabled: false },
  }));
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr !== 'object' || !addr) {
        reject(new Error('no port'));
        return;
      }
      const p = addr.port;
      srv.close(() => resolve(p));
    });
  });
}
