/**
 * Tests for SshServer — the n8n-side embedded ssh2.Server that accepts
 * outbound connections from Qs running autossh.
 *
 * Strategy:
 *   - Generate a real user CA + host keypair via ssh-keygen, plus a real
 *     device cert. Same approach as sshCertParser.test.ts.
 *   - Boot SshServer on a random localhost port.
 *   - Drive it with the system's `ssh` binary acting as the Q-side
 *     autossh stand-in. ssh dialing → cert auth → tcpip-forward request
 *     exercises every path the real Q would.
 *
 * Each test starts/stops its own SshServer to keep the singleton state
 * tractable. We use `(SshServer as any).getInstance()` for assertions on
 * the registry but boot via getInstance + listen + close like real code
 * does.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { SshServer } from '../src/SshServer.js';

let WORKDIR: string;
let CA: string; // path prefix; .pub is the public side
let HOST: string; // path prefix; .pub is the host pubkey

beforeAll(() => {
  WORKDIR = mkdtempSync(path.join(tmpdir(), 'ssh-server-test-'));
  CA = path.join(WORKDIR, 'user-ca');
  HOST = path.join(WORKDIR, 'ssh_host_ed25519_key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test:user-ca', '-f', CA]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test:host', '-f', HOST]);
});

afterEach(async () => {
  // Reset the singleton between tests. The tests are intentionally
  // sequential and each owns the listener.
  await SshServer.getInstance().close();
});

interface DeviceBundle {
  keyPath: string;
  certPath: string;
}

function issueDeviceCert(opts: {
  keyId: string;
  principals?: string;
  validityDays?: number;
  extensions?: string[];
  criticalOptions?: string[];
}): DeviceBundle {
  const id = `${opts.keyId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const keyPath = path.join(WORKDIR, `${id}-key`);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `test:${opts.keyId}`, '-f', keyPath]);
  const args = [
    '-q',
    '-s',
    CA,
    '-I',
    opts.keyId,
    '-n',
    opts.principals ?? 'tunnel',
    '-V',
    `+${opts.validityDays ?? 30}d`,
    '-O',
    'clear',
  ];
  for (const ext of opts.extensions ?? ['permit-port-forwarding']) args.push('-O', ext);
  for (const co of opts.criticalOptions ?? []) args.push('-O', co);
  args.push(`${keyPath}.pub`);
  execFileSync('ssh-keygen', args);
  return { keyPath, certPath: `${keyPath}-cert.pub` };
}

/**
 * Spawn an `ssh` client process configured to dial the running SshServer
 * with the provided device bundle. Returns the child process; caller is
 * responsible for killing it once the test assertion is done.
 */
function spawnQSsh(opts: {
  port: number;
  bundle: DeviceBundle;
  /** Ports to forward; defaults to one `-R` to a dummy unix path. */
  forwards?: string[];
}): { proc: ChildProcess; knownHostsPath: string } {
  // Pin the host pubkey for this hostname:port — mirrors what
  // q/entrypoint.sh does in production.
  const knownHostsPath = path.join(WORKDIR, `kh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const hostPub = readFileSync(`${HOST}.pub`, 'utf8').trim();
  writeFileSync(knownHostsPath, `[127.0.0.1]:${opts.port} ${hostPub}\n`);

  const args = [
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${knownHostsPath}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'PreferredAuthentications=publickey',
    '-i',
    opts.bundle.keyPath,
    '-o',
    `CertificateFile=${opts.bundle.certPath}`,
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ConnectTimeout=3',
    '-o',
    'ServerAliveInterval=3',
    '-N',
    '-p',
    String(opts.port),
  ];
  for (const fwd of opts.forwards ?? ['127.0.0.1:7000:/tmp/dummy-target.sock']) {
    args.push('-R', fwd);
  }
  args.push('tunnel@127.0.0.1');
  // stdio piped so we can inspect stderr in flaky tests; closed by default.
  const proc = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return { proc, knownHostsPath };
}

/** Wait until `cond()` returns true, polling every 50ms. Times out after `timeoutMs`. */
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Pick a free port to bind for this test run. */
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

const COMMON_CONFIG = () =>
  ({
    listenAddress: '127.0.0.1',
    listenPort: 0, // overridden per-test
    hostPrivateKey: readFileSync(HOST),
    userCaPublicKey: readFileSync(`${CA}.pub`, 'utf8'),
    requiredPrincipal: 'tunnel',
    connectTimeoutMs: 3000,
  }) as const;

describe('SshServer.listen + connection lifecycle', () => {
  it('accepts a valid cert and registers the device by keyId', async () => {
    const port = await freePort();
    const server = SshServer.getInstance();
    await server.listen({ ...COMMON_CONFIG(), listenPort: port });

    const bundle = issueDeviceCert({ keyId: 'kitchen' });
    const { proc } = spawnQSsh({ port, bundle });

    await waitFor(() => server._peekRegistry().has('kitchen'));
    const entry = server._peekRegistry().get('kitchen')!;
    expect(entry.bindAddr).toBe('127.0.0.1');
    expect(entry.bindPort).toBe(7000);

    proc.kill();
  });

  it('rejects a cert signed by a different CA (registry stays empty)', async () => {
    const port = await freePort();
    const server = SshServer.getInstance();
    await server.listen({ ...COMMON_CONFIG(), listenPort: port });

    // Build a different CA + a device cert signed by it.
    const otherCa = path.join(WORKDIR, `other-ca-${Date.now()}`);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'other-ca', '-f', otherCa]);
    const id = `intruder-${Date.now()}`;
    const keyPath = path.join(WORKDIR, `${id}-key`);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `test:${id}`, '-f', keyPath]);
    execFileSync('ssh-keygen', [
      '-q',
      '-s',
      otherCa,
      '-I',
      'intruder',
      '-n',
      'tunnel',
      '-V',
      '+30d',
      '-O',
      'clear',
      '-O',
      'permit-port-forwarding',
      `${keyPath}.pub`,
    ]);
    const bundle: DeviceBundle = { keyPath, certPath: `${keyPath}-cert.pub` };

    const { proc } = spawnQSsh({ port, bundle });
    // Give ssh enough time to fail auth and exit; reject must be observable.
    await new Promise((r) => setTimeout(r, 1500));
    expect(server._peekRegistry().has('intruder')).toBe(false);
    proc.kill();
  });

  it('rejects a cert without permit-port-forwarding', async () => {
    const port = await freePort();
    const server = SshServer.getInstance();
    await server.listen({ ...COMMON_CONFIG(), listenPort: port });

    // Note: -O clear with no extensions strips everything.
    const bundle = issueDeviceCert({ keyId: 'no-fwd', extensions: [] });
    const { proc } = spawnQSsh({ port, bundle });
    await new Promise((r) => setTimeout(r, 1500));
    expect(server._peekRegistry().has('no-fwd')).toBe(false);
    proc.kill();
  });

  it('rejects a cert whose principal does not include the required one', async () => {
    const port = await freePort();
    const server = SshServer.getInstance();
    await server.listen({ ...COMMON_CONFIG(), listenPort: port });

    const bundle = issueDeviceCert({ keyId: 'wrong-principal', principals: 'admin' });
    const { proc } = spawnQSsh({ port, bundle });
    await new Promise((r) => setTimeout(r, 1500));
    expect(server._peekRegistry().has('wrong-principal')).toBe(false);
    proc.kill();
  });

  it('evicts the prior client when a new one claims the same keyId (zombie reconnect)', async () => {
    const port = await freePort();
    const server = SshServer.getInstance();
    await server.listen({ ...COMMON_CONFIG(), listenPort: port });

    // Two distinct device certs with the SAME keyId. In production
    // `pki add device <nick>` refuses duplicates; for this test we
    // bypass that and issue twice manually.
    const bundleA = issueDeviceCert({ keyId: 'samename' });
    const bundleB = issueDeviceCert({ keyId: 'samename' });

    const { proc: procA } = spawnQSsh({ port, bundle: bundleA });
    await waitFor(() => server._peekRegistry().has('samename'));
    const firstClient = server._peekRegistry().get('samename')!.client;

    const { proc: procB } = spawnQSsh({ port, bundle: bundleB });
    // Wait until the registry entry's client object has changed.
    await waitFor(() => {
      const entry = server._peekRegistry().get('samename');
      return entry !== undefined && entry.client !== firstClient;
    });

    procA.kill();
    procB.kill();
  });

  it('connect(deviceNick) waits up to connectTimeoutMs and rejects when no Q appears', async () => {
    const port = await freePort();
    const server = SshServer.getInstance();
    await server.listen({ ...COMMON_CONFIG(), listenPort: port, connectTimeoutMs: 200 });
    await expect(server.connect('ghost')).rejects.toThrow(/not connected.*200ms/);
  });

  it('listen() with a conflicting host key throws on the second call', async () => {
    const port = await freePort();
    const server = SshServer.getInstance();
    await server.listen({ ...COMMON_CONFIG(), listenPort: port });

    // Generate a different host key and try to re-listen.
    const otherHost = path.join(WORKDIR, `host-other-${Date.now()}`);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test:host-other', '-f', otherHost]);
    await expect(
      server.listen({
        ...COMMON_CONFIG(),
        listenPort: port,
        hostPrivateKey: readFileSync(otherHost),
      }),
    ).rejects.toThrow(/different host key/);
  });
});
