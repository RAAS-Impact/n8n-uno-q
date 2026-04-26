/**
 * SshServer — process-singleton ssh2.Server that accepts outbound SSH
 * connections from Qs (Variant B reverse-SSH deployment, master-plan §14).
 *
 * Each incoming connection is a Q running autossh that:
 *   1. Authenticates via OpenSSH user cert signed by our user CA. The
 *      server-side parsing + signature check live in sshCertParser; we
 *      use them in the auth callback.
 *   2. Issues a `tcpip-forward` global request to ask us to accept the
 *      reverse forward. We don't bind a real listener (ssh2 leaves that
 *      to the user code, which is ideal — see master-plan §14 discussion
 *      of bindPort routing). Instead we tag the client in a registry by
 *      its cert KeyID and call it a day.
 *
 * When a node wants to reach a Q, it calls `connect(deviceNick)` which:
 *   - Looks up the client in the registry.
 *   - Calls `forwardOut(bindAddr, bindPort, ...)` on the existing SSH
 *     session — this opens a `direct-tcpip` channel inside the already-
 *     established TCP socket, forwarded back to the Q. The Q's autossh
 *     wires it through to /var/run/arduino-router.sock.
 *   - Returns the Duplex stream to the caller (BridgeManager) for the
 *     Bridge.connect path via SshTransport.
 *
 * Keying:
 *   - Singleton on globalThis under Symbol.for(...). Each esbuild bundle
 *     of a node file has its own copy of this module; the symbol unifies
 *     them at the n8n process boundary, exactly like BridgeManager.
 *   - One process can bind one listen port. Multiple credentials sharing
 *     the same listen address/port are expected (one credential per Q,
 *     same SSH endpoint) and they share the singleton. Conflicting
 *     credential configs (different host keys for the same listener)
 *     are rejected at boot time.
 *
 * What this DOES NOT do (yet, intentionally):
 *   - Active revocation. Master-plan §14.6: no Revoked Serials field
 *     in v1, mirroring relay-mtls. Cert validity window + re-bootstrap
 *     are the policy.
 *   - Idle disconnect timer. The credential field is wired through but
 *     the timer is not implemented in this iteration — n8n's queue-mode
 *     limitations make this less useful than it sounds and we'd rather
 *     ship without dead config (master-plan §14.9).
 *   - Host-cert advertising. ssh2 v1.17 doesn't support it (§14.2
 *     follow-up); devices verify the n8n endpoint via host-key
 *     fingerprint pinning in their known_hosts.
 */
import type { AuthContext, ClientInfo, Connection } from 'ssh2';
import { Server as Ssh2Server, utils as ssh2Utils } from 'ssh2';
import type { Duplex } from 'node:stream';
import { parseSshUserCert, verifySshUserCert } from './sshCertParser.js';

const SINGLETON_KEY = Symbol.for('@raasimpact/arduino-uno-q/ssh-server');

const DEBUG = process.env.DEBUG?.includes('ssh-server') ?? false;
function debug(category: string, ...args: unknown[]) {
  if (DEBUG) console.debug(`[ssh-server:${category}]`, ...args);
}

/** Configuration the first credential supplies; later credentials must match. */
export interface SshServerConfig {
  /** Bind address. 0.0.0.0 by default; 127.0.0.1 if behind a reverse proxy. */
  listenAddress: string;
  /** TCP port the embedded SSH server binds. */
  listenPort: number;
  /** PEM/OpenSSH private key the server presents during KEX. */
  hostPrivateKey: Buffer | string;
  /** OpenSSH-format public key of the user CA that signs device certs. */
  userCaPublicKey: string;
  /** Required principal in every accepted device cert (defense-in-depth). */
  requiredPrincipal: string;
  /** Max wait when `connect(deviceNick)` is called and the device isn't yet in the registry. */
  connectTimeoutMs: number;
}

interface RegistryEntry {
  client: Connection;
  bindAddr: string;
  bindPort: number;
  /** Promise resolvers waiting for this device to appear (connect race). */
  pending: Array<(entry: RegistryEntry) => void>;
}

interface PendingConnect {
  deviceNick: string;
  resolve: (entry: RegistryEntry) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class SshServer {
  private server: Ssh2Server | null = null;
  private config: SshServerConfig | null = null;
  /** keyId → registry entry. Routing in §14.4 is by keyId only. */
  private registry = new Map<string, RegistryEntry>();
  /** Connect waiters keyed by deviceNick — flushed when the device shows up. */
  private waiters = new Map<string, PendingConnect[]>();

  static getInstance(): SshServer {
    const g = globalThis as unknown as Record<symbol, SshServer | undefined>;
    if (!g[SINGLETON_KEY]) {
      g[SINGLETON_KEY] = new SshServer();
    }
    return g[SINGLETON_KEY]!;
  }

  /**
   * Idempotent boot. The first call binds the listener with the supplied
   * config. Subsequent calls are no-ops UNLESS the new config conflicts
   * with the active one — then we throw, because there's no safe way to
   * rebind a single process to two SSH servers on the same port.
   *
   * Per-credential config drift (e.g. user edits the host private key)
   * is detected here; n8n needs a process restart to pick up such a
   * change. Documented in deploy/relay-ssh/README.md.
   */
  async listen(config: SshServerConfig): Promise<void> {
    if (this.server) {
      this.assertConfigMatches(config);
      return;
    }
    this.config = { ...config };

    const server = new Ssh2Server(
      {
        // ssh2.Server's parseKey is invoked internally on whatever we hand
        // it — pass the raw Buffer/string, not a pre-parsed key.
        hostKeys: [config.hostPrivateKey],
      },
      (client, info) => this.onConnection(client, info),
    );

    server.on('error', (err: Error) => debug('server-error', err));

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen(config.listenPort, config.listenAddress, () => {
        server.off('error', onError);
        debug('listen', `${config.listenAddress}:${config.listenPort}`);
        resolve();
      });
    });

    this.server = server;
  }

  /** Stop accepting new connections; close existing ones. Mostly for tests. */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    // End every connected client to release sockets cleanly.
    for (const entry of this.registry.values()) {
      try {
        entry.client.end();
      } catch {
        /* ignore */
      }
    }
    this.registry.clear();
    // Reject any in-flight waiters — connect() callers shouldn't hang past close.
    for (const list of this.waiters.values()) {
      for (const w of list) {
        clearTimeout(w.timer);
        w.reject(new Error('SshServer closed'));
      }
    }
    this.waiters.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.config = null;
  }

  /**
   * Open a Duplex stream forwarded to the device's arduino-router socket.
   *
   * Resolves immediately if the device is already in the registry.
   * Otherwise waits up to `connectTimeoutMs` for the device's autossh to
   * (re)connect — useful when the Bridge tries to dial right after a
   * temporary network blip.
   */
  async connect(deviceNick: string): Promise<Duplex> {
    if (!this.server || !this.config) {
      throw new Error('SshServer.connect() called before listen()');
    }
    const entry = await this.awaitDevice(deviceNick, this.config.connectTimeoutMs);
    return await this.forwardOut(entry);
  }

  // --- Connection lifecycle -------------------------------------------------

  private onConnection(client: Connection, info: ClientInfo): void {
    let deviceNick: string | null = null;

    debug('connect-from', info.ip);

    client.on('authentication', (ctx: AuthContext) => this.handleAuth(ctx, (nick) => (deviceNick = nick)));

    client.on('ready', () => {
      debug('client-ready', deviceNick ?? '<unauthenticated>');
    });

    client.on('request', (accept, reject, name, requestInfo) => {
      // Only tcpip-forward is meaningful. ssh2's typings declare info as
      // optional; for tcpip-forward it carries bindAddr / bindPort.
      if (name !== 'tcpip-forward') {
        debug('reject-request', name);
        if (reject) reject();
        return;
      }
      if (!deviceNick) {
        // Defensive: ssh2 only emits 'request' after auth, so this should
        // never fire — log if it does.
        debug('tcpip-forward-pre-auth');
        if (reject) reject();
        return;
      }
      const fwdInfo = requestInfo as { bindAddr: string; bindPort: number } | undefined;
      const bindAddr = fwdInfo?.bindAddr ?? '127.0.0.1';
      const bindPort = fwdInfo?.bindPort ?? 0;
      this.installEntry(deviceNick, client, bindAddr, bindPort);
      // accept(bindPort) just sends REQUEST_SUCCESS over SSH — it does NOT
      // open a real TCP listener (ssh2 leaves that to the user). Routing
      // is by keyId, not by bindPort; see master-plan §14.4.
      if (accept) accept(bindPort);
    });

    client.on('session', (acceptSession) => {
      // -N mode on the client side; the OpenSSH client may still open a
      // session for keep-alive purposes. Accept the channel but reject
      // every interactive sub-feature.
      const session = acceptSession();
      session.on('exec', (a, r) => r());
      session.on('shell', (a, r) => r());
      session.on('pty', (a, r) => r());
      session.on('subsystem', (a, r) => r());
    });

    client.on('close', () => {
      if (deviceNick) {
        const entry = this.registry.get(deviceNick);
        if (entry?.client === client) {
          this.registry.delete(deviceNick);
          debug('client-closed', deviceNick, `registry size=${this.registry.size}`);
        }
      }
    });

    client.on('error', (err: Error) => debug('client-error', deviceNick ?? '<pre-auth>', err.message));
  }

  // --- Auth callback --------------------------------------------------------

  private handleAuth(ctx: AuthContext, captureNick: (nick: string) => void): void {
    if (ctx.method !== 'publickey') {
      debug('auth-reject-method', ctx.method);
      ctx.reject(['publickey']);
      return;
    }

    // Pre-filter: only cert algorithms can be authenticated by SshServer.
    // Bare-key publickey (no cert) means the Q tried to dial without a
    // cert file configured — explicit reject is friendlier than letting
    // ssh2's protocol layer keep retrying methods.
    const algo = (ctx as unknown as { key?: { algo?: string } }).key?.algo ?? '';
    if (!algo.includes('cert-v01')) {
      debug('auth-reject-no-cert', algo);
      ctx.reject();
      return;
    }
    const data = (ctx as unknown as { key?: { data?: Buffer } }).key?.data;
    if (!data) {
      debug('auth-reject-no-data');
      ctx.reject();
      return;
    }

    let parsed;
    try {
      parsed = parseSshUserCert(data);
    } catch (err) {
      debug('auth-reject-parse', (err as Error).message);
      ctx.reject();
      return;
    }

    const cfg = this.config!;
    const verified = verifySshUserCert(parsed, cfg.userCaPublicKey);
    if (!verified.ok) {
      debug('auth-reject-signature', verified.reason);
      ctx.reject();
      return;
    }

    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (parsed.validAfter > nowSec) {
      debug('auth-reject-not-yet-valid', parsed.keyId);
      ctx.reject();
      return;
    }
    if (parsed.validBefore <= nowSec) {
      debug('auth-reject-expired', parsed.keyId);
      ctx.reject();
      return;
    }

    if (!parsed.principals.includes(cfg.requiredPrincipal)) {
      debug('auth-reject-principal', parsed.keyId, parsed.principals.join(','));
      ctx.reject();
      return;
    }

    if (!('permit-port-forwarding' in parsed.extensions)) {
      debug('auth-reject-extension', parsed.keyId);
      ctx.reject();
      return;
    }

    // Reject any non-empty critical-options set — we don't honour any
    // critical option in this design (force-command, source-address,
    // verify-required), so per OpenSSH spec we MUST reject.
    if (Object.keys(parsed.criticalOptions).length > 0) {
      debug('auth-reject-critical-options', parsed.keyId, Object.keys(parsed.criticalOptions).join(','));
      ctx.reject();
      return;
    }

    captureNick(parsed.keyId);
    debug('auth-accept', parsed.keyId);
    ctx.accept();
  }

  // --- Registry + routing ---------------------------------------------------

  /**
   * Install a (deviceNick → client) mapping. If a prior client claimed
   * the same nickname (zombie reconnect — the autossh hiccupped, the old
   * TCP session is still draining on our side), evict it before storing
   * the new one. Master-plan §14.9 calls this out.
   */
  private installEntry(deviceNick: string, client: Connection, bindAddr: string, bindPort: number): void {
    const prior = this.registry.get(deviceNick);
    if (prior && prior.client !== client) {
      debug('evict-prior', deviceNick);
      try {
        prior.client.end();
      } catch {
        /* ignore — close handler tidies up */
      }
    }
    const entry: RegistryEntry = { client, bindAddr, bindPort, pending: [] };
    this.registry.set(deviceNick, entry);

    // Flush any waiters that were blocked on this device showing up.
    const waiters = this.waiters.get(deviceNick);
    if (waiters) {
      this.waiters.delete(deviceNick);
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.resolve(entry);
      }
    }
  }

  /** Either return the current registry entry, or wait for it to appear. */
  private awaitDevice(deviceNick: string, timeoutMs: number): Promise<RegistryEntry> {
    const existing = this.registry.get(deviceNick);
    if (existing) return Promise.resolve(existing);
    return new Promise<RegistryEntry>((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(deviceNick);
        if (list) {
          const idx = list.indexOf(pending);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) this.waiters.delete(deviceNick);
        }
        reject(new Error(`device '${deviceNick}' not connected (waited ${timeoutMs}ms)`));
      }, timeoutMs);
      const pending: PendingConnect = { deviceNick, resolve, reject, timer };
      const list = this.waiters.get(deviceNick) ?? [];
      list.push(pending);
      this.waiters.set(deviceNick, list);
    });
  }

  private forwardOut(entry: RegistryEntry): Promise<Duplex> {
    return new Promise<Duplex>((resolve, reject) => {
      // forwardOut(bindAddr, bindPort, srcAddr, srcPort, cb). srcAddr/srcPort
      // are echoed to the Q in the direct-tcpip channel header — the Q-side
      // autossh ignores them, so loopback + port 0 is fine.
      entry.client.forwardOut(entry.bindAddr, entry.bindPort, '127.0.0.1', 0, (err, channel) => {
        if (err) {
          reject(err);
          return;
        }
        // ssh2.Channel extends stream.Duplex; cast for the public type.
        resolve(channel as unknown as Duplex);
      });
    });
  }

  // --- Internal helpers -----------------------------------------------------

  private assertConfigMatches(next: SshServerConfig): void {
    const cur = this.config!;
    if (cur.listenAddress !== next.listenAddress || cur.listenPort !== next.listenPort) {
      throw new Error(
        `SshServer already bound to ${cur.listenAddress}:${cur.listenPort}; ` +
          `cannot accept a new credential targeting ${next.listenAddress}:${next.listenPort}. ` +
          'Restart n8n to switch endpoints.',
      );
    }
    // Compare host keys by their parsed pubkey (cheap and stable across
    // PEM/OpenSSH format variations).
    const cmp = (k: Buffer | string) => {
      const parsed = ssh2Utils.parseKey(k);
      if (parsed instanceof Error) return null;
      const pub = Array.isArray(parsed) ? parsed[0] : parsed;
      return pub.getPublicSSH().toString('base64');
    };
    if (cmp(cur.hostPrivateKey) !== cmp(next.hostPrivateKey)) {
      throw new Error(
        'SshServer is already bound with a different host key. ' +
          'Two credentials cannot share a listener with mismatched host identities. ' +
          'Restart n8n to apply the new key.',
      );
    }
    if (cur.userCaPublicKey.trim() !== next.userCaPublicKey.trim()) {
      throw new Error(
        'SshServer is already configured with a different user CA. ' +
          'Two credentials cannot share a listener with mismatched trust roots.',
      );
    }
    // Other fields (requiredPrincipal, connectTimeoutMs) follow the first
    // credential. Ignored on subsequent calls — too small to be worth
    // surfacing as an error.
  }

  // --- Test helpers (not exported via index) --------------------------------

  /** @internal — for unit tests; not part of the public API. */
  _peekRegistry(): Map<string, RegistryEntry> {
    return this.registry;
  }
}
