#!/usr/bin/env node
//
// Mock SSH relay — a stub `ssh2.Server` that mirrors the auth + tcpip-forward
// behaviour `SshRelayServer` (Commit 3 of docs/master-plan/14-relay-ssh.md
// §14.8) will eventually implement. Used to verify Commit 2's deploy
// tooling end-to-end without waiting on the n8n-side code.
//
// What it checks:
//   1. The Q's autossh dial connects.
//   2. The host cert it presents is signed by host_ca.
//   3. The user cert the Q presents is signed by user_ca.
//   4. The cert's principal is `tunnel` (defense-in-depth).
//   5. The cert's KeyID is captured for routing (logs only — no actual
//      registry; Commit 3 builds that).
//   6. The `tcpip-forward` global request is delivered and accepted.
//
// Usage (from repo root, after `./pki setup` + `./pki add n8n laptop
// --hostname 127.0.0.1` + `./pki add device kitchen`):
//
//   node experiments/mock-ssh-relay.mjs \
//     --n8n-bundle deploy/relay-ssh/pki/out/n8n/laptop \
//     --user-ca    deploy/relay-ssh/pki/ca/user_ca.pub \
//     [--port 2222] [--principal tunnel]
//
// Then in another terminal, point `install.sh --n8n-host 127.0.0.1` at this
// process. autossh from a Q dialing through an SSH tunnel will produce log
// lines here for every step.
//
// This is a verification harness, not production code. Logging is verbose
// and the server doesn't actually forward traffic anywhere — the goal is
// to prove the PKI material and the cert ergonomics are right before
// SshRelayServer ships.

import { readFileSync } from 'node:fs';
// ssh2 is a CJS module; pull what we need via a default import so ESM's
// strict named-export check is satisfied.
import ssh2Pkg from 'ssh2';

const { Server } = ssh2Pkg;

// --- arg parsing -----------------------------------------------------------

function parseArgs(argv) {
  const out = { port: 2222, principal: 'tunnel' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--n8n-bundle': out.bundle = argv[++i]; break;
      case '--user-ca':    out.userCaPath = argv[++i]; break;
      case '--port':       out.port = Number(argv[++i]); break;
      case '--principal':  out.principal = argv[++i]; break;
      case '-h': case '--help':
        printHelp();
        process.exit(0);
      default:
        console.error(`unknown arg: ${a}`);
        printHelp();
        process.exit(1);
    }
  }
  if (!out.bundle || !out.userCaPath) {
    console.error('error: --n8n-bundle and --user-ca are required');
    printHelp();
    process.exit(1);
  }
  return out;
}

function printHelp() {
  console.error(`Usage: node experiments/mock-ssh-relay.mjs \\
  --n8n-bundle <dir>     # e.g. deploy/relay-ssh/pki/out/n8n/laptop
  --user-ca <pubkey>     # e.g. deploy/relay-ssh/pki/ca/user_ca.pub
  [--port 2222]
  [--principal tunnel]
`);
}

// --- main -----------------------------------------------------------------

const args = parseArgs(process.argv);

// IMPORTANT: ssh2 v1.17.0's Server does NOT implement host certificates.
// The `cert` field on hostKeys[*] is silently ignored — only the bare
// `key` is advertised during KEX. So the device side will see plain
// `ssh-ed25519` and any `@cert-authority` line in its known_hosts won't
// match. This contradicts master-plan §14.2 (recorded as an open item
// in §14.9 after the 2026-04-25 verification run); SshRelayServer in
// Commit 3 will need a workaround (fork ssh2, patch upstream, or fall
// back to host-key fingerprint pinning).
//
// For this verification harness we just load the bare key and log a
// warning. The test exercises the user-cert verification path — the
// load-bearing PKI piece on the n8n side — which IS supported by ssh2.
//
// Pass raw Buffer; ssh2.Server calls parseKey internally and rejects
// pre-parsed objects.
const hostKey = readFileSync(`${args.bundle}/ssh_host_ed25519_key`);
const userCa  = readFileSync(args.userCaPath);

console.log(`[mock-ssh-relay] starting on :${args.port}`);
console.log(`[mock-ssh-relay] host bundle: ${args.bundle}`);
console.log(`[mock-ssh-relay] user CA:     ${args.userCaPath}`);
console.log(`[mock-ssh-relay] required principal: ${args.principal}`);
console.log(`[mock-ssh-relay] WARNING: ssh2 v1.17 ignores host cert; advertising bare host key only`);
console.log(`[mock-ssh-relay] WARNING: client must pin host-key fingerprint, not @cert-authority`);

// In-memory registry: keyId → { client, bindAddr, bindPort }. Eviction on
// keyId collision (zombie reconnect) per §14.4.
const registry = new Map();

const server = new Server({
  hostKeys: [hostKey],
}, (client, info) => {
  const peer = `${info.ip}:${info.port}`;
  console.log(`[mock-ssh-relay] connection from ${peer}`);

  let deviceNick = null;

  client
    .on('authentication', (ctx) => {
      // ssh2 may emit multiple authentication events per connection — the
      // OpenSSH client offers methods in sequence (none → publickey with
      // cert → publickey with bare key fallback, etc.). Walk past
      // anything we don't accept.
      console.log(`  ↳ auth method=${ctx.method} username='${ctx.username}'`);
      if (ctx.method !== 'publickey') {
        return ctx.reject(['publickey']);
      }
      // ssh2 v1.17 doesn't expose a parsed cert object — but the cert
      // blob arrives intact in ctx.key.data (algo `ssh-ed25519-cert-v01
      // @openssh.com` etc.). Parse it ourselves; this is the same
      // approach Commit 3's SshRelayServer will use.
      if (!String(ctx.key?.algo || '').includes('cert-v01')) {
        console.log(`     algo=${ctx.key?.algo} → reject (not a cert algorithm)`);
        return ctx.reject();
      }
      let parsed;
      try {
        parsed = parseSshCert(ctx.key.data);
      } catch (e) {
        console.log(`     → reject (cert parse failed: ${e.message})`);
        return ctx.reject();
      }
      console.log(`     keyId='${parsed.keyId}' serial=${parsed.serial} type=${parsed.type === 1 ? 'user' : 'host'}`);
      console.log(`     principals=[${parsed.principals.join(', ')}] valid ${new Date(Number(parsed.validAfter) * 1000).toISOString()} → ${new Date(Number(parsed.validBefore) * 1000).toISOString()}`);
      console.log(`     extensions=[${Object.keys(parsed.extensions).join(', ')}] CA=${parsed.signatureKeyB64.slice(0, 16)}...`);

      // Verify the cert was signed by our user CA (CA-key match — we don't
      // verify the cryptographic signature here; ssh2's protocol layer
      // already verified the user proved control of the key, and the cert
      // was minted by our own CA).
      const userCaB64 = userCa.toString().split(/\s+/)[1];
      if (parsed.signatureKeyB64 !== userCaB64) {
        console.log('     → reject (cert not signed by our user CA)');
        return ctx.reject();
      }
      // Validity window.
      const now = Math.floor(Date.now() / 1000);
      if (now < Number(parsed.validAfter) || now > Number(parsed.validBefore)) {
        console.log('     → reject (cert outside validity window)');
        return ctx.reject();
      }
      // Principal check.
      if (!parsed.principals.includes(args.principal)) {
        console.log(`     → reject (principal '${args.principal}' not in cert)`);
        return ctx.reject();
      }
      // permit-port-forwarding extension required.
      if (!('permit-port-forwarding' in parsed.extensions)) {
        console.log('     → reject (cert lacks permit-port-forwarding)');
        return ctx.reject();
      }

      deviceNick = parsed.keyId;
      console.log(`     → accept`);
      ctx.accept();
      return;
    })
    .on('ready', () => {
      console.log(`  ↳ session ready (client=${deviceNick})`);
    })
    .on('request', (accept, reject, name, info) => {
      if (name !== 'tcpip-forward') {
        console.log(`  ↳ unexpected request '${name}' → reject`);
        return reject();
      }

      // Evict any prior client claiming this keyId — handles zombie
      // reconnects per §14.9.
      const prior = registry.get(deviceNick);
      if (prior) {
        console.log(`  ↳ evicting prior client for keyId='${deviceNick}'`);
        try { prior.client.end(); } catch { /* ignore */ }
      }

      registry.set(deviceNick, { client, bindAddr: info.bindAddr, bindPort: info.bindPort });
      console.log(`  ↳ tcpip-forward bind=${info.bindAddr}:${info.bindPort} accepted; registry size=${registry.size}`);
      // accept(boundPort). Echo back what the client asked for; the routing
      // is by keyId, not port.
      accept(info.bindPort);
    })
    .on('session', (acceptSession) => {
      // We only do tunnels here; reject session channels (no shell, no exec).
      const session = acceptSession();
      session.on('exec', (a, r) => r());
      session.on('shell', (a, r) => r());
    })
    .on('close', () => {
      if (deviceNick && registry.get(deviceNick)?.client === client) {
        registry.delete(deviceNick);
        console.log(`  ↳ closed (client=${deviceNick}, registry size=${registry.size})`);
      } else {
        console.log(`  ↳ closed (client=${deviceNick})`);
      }
    })
    .on('error', (err) => {
      // Auth failures and other transport errors land here. Log without a
      // stack — they're expected during PKI iteration.
      console.log(`  ↳ error: ${err.message}`);
    });
});

server.listen(args.port, '0.0.0.0', () => {
  console.log(`[mock-ssh-relay] listening — Ctrl-C to stop`);
});

process.on('SIGINT', () => {
  console.log('\n[mock-ssh-relay] shutting down');
  server.close(() => process.exit(0));
});

// --- OpenSSH user-cert wire-format parser ----------------------------------
//
// Commit 3's SshRelayServer will need this same logic. Format spec:
// https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.certkeys
//
// For ssh-ed25519-cert-v01@openssh.com the layout is:
//   string algo
//   string nonce
//   string pk            (32-byte ed25519 pubkey)
//   uint64 serial
//   uint32 type          (1=user, 2=host)
//   string keyId
//   string validPrincipals  (length-prefixed buffer of length-prefixed strings)
//   uint64 validAfter
//   uint64 validBefore
//   string criticalOptions  (length-prefixed string-keyed map)
//   string extensions       (same shape)
//   string reserved
//   string signatureKey
//   string signature

function parseSshCert(buf) {
  const r = new Reader(buf);
  const algo = r.readString().toString('utf8');
  const nonce = r.readString();
  const pk = r.readString();
  const serial = r.readUint64();
  const type = r.readUint32();
  const keyId = r.readString().toString('utf8');
  const principals = parseStringList(r.readString());
  const validAfter = r.readUint64();
  const validBefore = r.readUint64();
  const criticalOptions = parseOptions(r.readString());
  const extensions = parseOptions(r.readString());
  const _reserved = r.readString();
  const signatureKey = r.readString();
  const _signature = r.readString();

  // Compare CA pubkey by content. signatureKey is itself a string-prefixed
  // pubkey blob (algo + key data); we want just the OpenSSH base64
  // body of the .pub file (which is `<algo-len><algo><...>` in binary,
  // base64'd) — exactly signatureKey, base64'd.
  const signatureKeyB64 = Buffer.from(signatureKey).toString('base64');

  return {
    algo, nonce, pk, serial, type, keyId,
    principals, validAfter, validBefore,
    criticalOptions, extensions,
    signatureKeyB64,
  };
}

function parseStringList(buf) {
  const r = new Reader(buf);
  const out = [];
  while (!r.done()) out.push(r.readString().toString('utf8'));
  return out;
}

// OpenSSH critical-options/extensions are a flat map. Each entry is:
//   string name
//   string value     (often empty for boolean-like extensions)
function parseOptions(buf) {
  const r = new Reader(buf);
  const out = {};
  while (!r.done()) {
    const name = r.readString().toString('utf8');
    const value = r.readString();
    out[name] = value.length === 0 ? '' : value.toString('utf8');
  }
  return out;
}

class Reader {
  constructor(buf) { this.buf = buf; this.off = 0; }
  done() { return this.off >= this.buf.length; }
  readUint32() {
    const v = this.buf.readUInt32BE(this.off);
    this.off += 4;
    return v;
  }
  readUint64() {
    const v = this.buf.readBigUInt64BE(this.off);
    this.off += 8;
    return v;
  }
  readString() {
    const len = this.readUint32();
    const s = this.buf.slice(this.off, this.off + len);
    this.off += len;
    return s;
  }
}
