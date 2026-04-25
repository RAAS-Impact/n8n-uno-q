#!/usr/bin/env node
// Shared `$/version` smoke probe used by deploy/{relay,relay-mtls}/check.sh.
//
// Connects to a relay endpoint via TCP or mTLS, performs a single `$/version`
// MessagePack-RPC call, prints the result as one JSON line, and exits 0 on
// success / 1 on failure / 2 on bad arguments.
//
// Env vars:
//   PROBE_MODE        'tcp' | 'tls'
//   PROBE_HOST        hostname / IP of the relay
//   PROBE_PORT        TCP port (default 5775)
//   PROBE_CA_FILE     (tls only) path to ca.pem
//   PROBE_CERT_FILE   (tls only) path to client.pem
//   PROBE_KEY_FILE    (tls only) path to client.key
//   PROBE_TIMEOUT_MS  per-call timeout, default 5000
//
// Stdout (one JSON line):
//   { ok: true,  version: "...",  elapsed_ms: N }
//   { ok: false, error:  "..." }
//
// The bridge package is loaded directly from the workspace dist — this script
// is meant to be run from a developer checkout, not shipped to the Q.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIST = resolve(HERE, '..', '..', 'packages', 'bridge', 'dist', 'index.js');

let Bridge, TcpTransport, TlsTransport;
try {
  ({ Bridge, TcpTransport, TlsTransport } = await import(BRIDGE_DIST));
} catch (err) {
  console.error(
    `Failed to load bridge from ${BRIDGE_DIST}.\n` +
      `Run \`npm run build -w packages/bridge\` first.\n` +
      `Underlying error: ${err?.message ?? err}`,
  );
  process.exit(2);
}

const mode = process.env.PROBE_MODE;
const host = process.env.PROBE_HOST;
const port = Number(process.env.PROBE_PORT ?? 5775);
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? 5000);

if (!mode || !host) {
  console.error('PROBE_MODE and PROBE_HOST are required.');
  process.exit(2);
}

let transport;
if (mode === 'tcp') {
  transport = new TcpTransport({ host, port });
} else if (mode === 'tls') {
  const caFile = process.env.PROBE_CA_FILE;
  const certFile = process.env.PROBE_CERT_FILE;
  const keyFile = process.env.PROBE_KEY_FILE;
  if (!caFile || !certFile || !keyFile) {
    console.error('PROBE_CA_FILE, PROBE_CERT_FILE and PROBE_KEY_FILE are required for tls mode.');
    process.exit(2);
  }
  transport = new TlsTransport({
    host,
    port,
    ca: readFileSync(caFile, 'utf8'),
    cert: readFileSync(certFile, 'utf8'),
    key: readFileSync(keyFile, 'utf8'),
  });
} else {
  console.error(`Unknown PROBE_MODE: ${mode} (expected 'tcp' or 'tls').`);
  process.exit(2);
}

let bridge;
try {
  bridge = await Bridge.connect({
    transportInstance: transport,
    reconnect: { enabled: false },
  });
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: `connect failed: ${err?.message ?? err}` }));
  process.exit(1);
}

const t0 = Date.now();
try {
  const version = await bridge.callWithTimeout('$/version', timeoutMs);
  const elapsed_ms = Date.now() - t0;
  console.log(JSON.stringify({ ok: true, version, elapsed_ms }));
  process.exit(0);
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
  process.exit(1);
} finally {
  await bridge.close().catch(() => {});
}
