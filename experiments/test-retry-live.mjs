#!/usr/bin/env node
// Live verification of Bridge.callWithOptions retry on a mid-call router
// restart. Sustains a ping loop while SSH-triggering `systemctl restart
// arduino-router`, so the socket actually drops during in-flight calls — the
// one thing MockRouter unit tests can't prove.
//
// Covers both transports. Configure via env:
//
//   A. Unix socket (default) — SSH tunnel the router socket to the PC:
//        rm -f /tmp/arduino-router.sock
//        ssh -N -L /tmp/arduino-router.sock:/var/run/arduino-router.sock arduino@linucs.local
//      Then:  node experiments/test-retry-live.mjs
//      Override the default path with UNOQ_SOCKET.
//
//   B. TCP (Variant A relay container, CONTEXT.md §12.5.1):
//      On the Q:  cd ~/n8n/relay && docker compose up -d
//      On the PC: ssh -N -L 5775:localhost:5775 arduino@linucs.local
//      Then:  UNOQ_TCP_HOST=127.0.0.1 UNOQ_TCP_PORT=5775 node experiments/test-retry-live.mjs
//
// Set both UNOQ_SOCKET and UNOQ_TCP_HOST+UNOQ_TCP_PORT to exercise both
// transports back-to-back in a single run (useful for multi-Q refactor smoke).
//
// Prereq (both transports): passwordless sudo on the Q for the restart cmd —
//   ssh arduino@linucs.local
//   sudo visudo -f /etc/sudoers.d/arduino-router
//   # add this single line:
//   arduino ALL=(root) NOPASSWD: /bin/systemctl restart arduino-router
//
// Prereq (both transports): bridge package built —
//   npm run build -w packages/bridge
//
// Env overrides: UNOQ_SOCKET, UNOQ_TCP_HOST, UNOQ_TCP_PORT, UNOQ_SSH.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeDist = path.resolve(here, '../packages/bridge/dist/index.js');
if (!existsSync(bridgeDist)) {
  console.error(`Bridge build not found at ${bridgeDist}`);
  console.error('Run: npm run build -w packages/bridge');
  process.exit(1);
}
const { Bridge } = await import(bridgeDist);

const SSH_HOST = process.env.UNOQ_SSH ?? 'arduino@linucs.local';

// --- cases (transport configurations) -------------------------------------

function probeUnix(socketPath) {
  return new Promise((resolve) => {
    const s = net.createConnection(socketPath);
    const done = (ok) => {
      s.removeAllListeners();
      try { s.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function probeTcp(host, port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const done = (ok) => {
      s.removeAllListeners();
      try { s.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

const RECONNECT = { enabled: true, baseDelayMs: 200, maxDelayMs: 2000 };

function makeUnixCase(socketPath) {
  return {
    name: 'unix',
    label: socketPath,
    opts: { socket: socketPath, reconnect: RECONNECT },
    probe: () => probeUnix(socketPath),
    reopenHint:
      `rm -f ${socketPath}\n` +
      `  ssh -N -L ${socketPath}:/var/run/arduino-router.sock ${SSH_HOST}`,
  };
}

function makeTcpCase(host, port) {
  return {
    name: 'tcp',
    label: `${host}:${port}`,
    opts: { transport: { kind: 'tcp', host, port }, reconnect: RECONNECT },
    probe: () => probeTcp(host, port),
    reopenHint:
      `On the Q:  cd ~/n8n/relay && docker compose up -d\n` +
      `  On the PC: ssh -N -L ${port}:localhost:${port} ${SSH_HOST}`,
  };
}

const cases = [];
if (process.env.UNOQ_SOCKET) {
  cases.push(makeUnixCase(process.env.UNOQ_SOCKET));
} else if (!process.env.UNOQ_TCP_HOST) {
  // Legacy default: no env vars set → unix at the canonical tunnel path.
  cases.push(makeUnixCase('/tmp/arduino-router.sock'));
}

if (process.env.UNOQ_TCP_HOST && process.env.UNOQ_TCP_PORT) {
  cases.push(makeTcpCase(process.env.UNOQ_TCP_HOST, Number(process.env.UNOQ_TCP_PORT)));
}

if (cases.length === 0) {
  console.error(
    'Invalid env: UNOQ_TCP_HOST set but UNOQ_TCP_PORT missing. ' +
    'Set both, or set UNOQ_SOCKET, or run without env vars for the default unix path.',
  );
  process.exit(1);
}

// --- helpers --------------------------------------------------------------

function ssh(cmd) {
  return new Promise((resolve, reject) => {
    const p = spawn('ssh', ['-o', 'BatchMode=yes', SSH_HOST, cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`ssh "${cmd}" exited ${code}: ${err.trim()}`));
    });
  });
}

async function probeAny() {
  // Return true as soon as any configured case's endpoint accepts a connection.
  const results = await Promise.all(cases.map((c) => c.probe()));
  return results.some(Boolean);
}

async function probeSudo() {
  // The only reliable probe of the exact NOPASSWD rule is to actually run the
  // allowed command. `sudo -n -l <cmd>` is too permissive on some sudo
  // versions. We do one real restart upfront, wait for the router to recover,
  // then proceed. If the user's sudoers rule is missing, this surfaces it
  // cleanly before any bridge is opened.
  console.log('Probing passwordless sudo (will restart arduino-router once)...');
  try {
    await ssh('sudo -n /bin/systemctl restart arduino-router');
  } catch (err) {
    const msg = err.message;
    if (/password/i.test(msg) && /required|needed|sorry/i.test(msg)) {
      return false;
    }
    // Any other ssh error (network, unknown host, etc.) — rethrow.
    throw err;
  }
  console.log('  restart issued; waiting 4s for router to come back...');
  await new Promise((r) => setTimeout(r, 4000));
  // Confirm router is back by probing ANY configured endpoint.
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await probeAny()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('router did not come back within 9s after probe-restart');
}

// --- the test -------------------------------------------------------------

async function warmup(bridge) {
  // Idempotent + generous budget. On TCP through socat, the first connect
  // after a recent router restart can race socat's per-child unix-backend
  // dial — the TCP handshake succeeds, the unix dial fails, socat closes
  // the TCP side, Bridge retries. idempotent:true absorbs that blip so the
  // scenario starts from a known-good state instead of erroring out before
  // the interesting part begins.
  const v = await bridge.callWithOptions('$/version', [], {
    idempotent: true,
    timeoutMs: 5000,
  });
  console.log(`  warm-up $/version: ${v}`);
}

async function runScenario(c, label, idempotent) {
  console.log(`\n=== ${label} (${c.name}, idempotent=${idempotent}) ===`);
  // Pre-probe: between scenarios the endpoint can wobble (or even die from
  // the previous restart cycle). Without this check, a dead endpoint would
  // surface as an unhandled `error` event from Bridge.connect — kills the
  // script and obscures the real result.
  if (!(await c.probe())) {
    console.error(`  Endpoint ${c.label} (${c.name}) not reachable — aborting scenario.`);
    console.error(`  Re-open:`);
    console.error(`  ${c.reopenHint}`);
    process.exit(1);
  }
  const bridge = await Bridge.connect(c.opts);
  bridge.on('reconnect', () => console.log('  [bridge] reconnected'));
  bridge.on('disconnect', () => console.log('  [bridge] disconnected'));
  bridge.on('error', (e) => console.log(`  [bridge] error: ${e.message}`));

  await warmup(bridge);

  // A sustained 10-second ping loop. The 1.5s mark is when we kick off the
  // router restart — the restart itself takes ~1-3s end-to-end, so many calls
  // fire before/during/after the drop. For idempotent=true we expect every
  // call to eventually succeed (retry compensates). For idempotent=false we
  // expect some to surface ConnectionError.
  const TOTAL_MS = 10_000;
  const INTERVAL_MS = 80;
  const RESTART_AT_MS = 1500;

  const start = Date.now();
  const pendings = [];
  let restartTriggered = false;

  while (Date.now() - start < TOTAL_MS) {
    const t = Date.now() - start;

    if (!restartTriggered && t >= RESTART_AT_MS) {
      restartTriggered = true;
      console.log(`  [ssh] t=${t}ms: restarting arduino-router...`);
      ssh('sudo -n /bin/systemctl restart arduino-router')
        .then(() => console.log(`  [ssh] t=${Date.now() - start}ms: restart returned`))
        .catch((e) => console.error(`  [ssh] restart FAILED: ${e.message}`));
    }

    const callT = t;
    pendings.push(
      bridge
        .callWithOptions('$/version', [], { idempotent, timeoutMs: 15_000 })
        .then((r) => ({ ok: true, t: callT, r }))
        .catch((e) => ({ ok: false, t: callT, e: e.constructor.name, msg: e.message })),
    );

    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  const results = await Promise.all(pendings);
  await bridge.close();

  const ok = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok);
  const connErrs = fail.filter((f) => f.e === 'ConnectionError').length;
  const timeouts = fail.filter((f) => f.e === 'TimeoutError').length;
  const others = fail.filter((f) => f.e !== 'ConnectionError' && f.e !== 'TimeoutError');

  console.log(
    `  total: ${results.length}   ok: ${ok}   ConnectionError: ${connErrs}   TimeoutError: ${timeouts}   other: ${others.length}`,
  );
  for (const o of others) console.log(`    [t=${o.t}ms] ${o.e}: ${o.msg}`);

  return { total: results.length, ok, connErrs, timeouts, others };
}

function reportVerdict(transport, idResult, noResult) {
  console.log(`\n--- Verdict (${transport}) ---`);
  let code = 0;

  // The retry contract from CONTEXT.md §6.4 says: idempotent calls survive
  // socket disruption. The success criterion is "no ConnectionError leaks
  // through to the caller" — TimeoutError on a tiny minority is acceptable
  // (e.g. router took longer than the budget to come back, or the retry
  // itself raced a second drop). The interesting comparison is with the
  // non-idempotent run, where ConnectionError MUST surface.
  if (idResult.connErrs === 0 && idResult.others.length === 0) {
    if (idResult.timeouts === 0) {
      console.log(`OK  idempotent=true:  all ${idResult.total} calls succeeded; retry fully compensated`);
    } else {
      console.log(
        `OK  idempotent=true:  ${idResult.timeouts}/${idResult.total} TimeoutError, 0 ConnectionError — retry caught every socket drop (timeouts are within-budget races)`,
      );
    }
  } else {
    console.log(
      `FAIL idempotent=true:  ${idResult.connErrs} ConnectionError surfaced — retry did NOT compensate`,
    );
    code = 1;
  }

  if (noResult.connErrs > 0) {
    console.log(
      `OK  idempotent=false: ${noResult.connErrs} ConnectionError(s) surfaced (expected — no retry on non-idempotent)`,
    );
    if (idResult.connErrs === 0) {
      console.log(
        `    → contrast: idempotent=true had 0 ConnectionError. Retry compensation is real.`,
      );
    }
  } else if (noResult.total > 0 && noResult.ok === noResult.total) {
    console.log(
      `?   idempotent=false: no errors — restart may have missed the in-flight window (timing-sensitive). Re-run to exercise the no-retry path.`,
    );
  } else {
    console.log(`FAIL idempotent=false: unexpected failure distribution: ${JSON.stringify(noResult)}`);
    code = 1;
  }

  return code;
}

// --- main -----------------------------------------------------------------

console.log(`SSH host: ${SSH_HOST}`);
console.log(`Transports: ${cases.map((c) => `${c.name}(${c.label})`).join(', ')}`);

if (!(await probeAny())) {
  console.error(`\nCannot reach any configured endpoint. Reopen:`);
  for (const c of cases) {
    console.error(`  [${c.name}] ${c.label}:`);
    console.error(`    ${c.reopenHint}`);
  }
  process.exit(1);
}

try {
  if (!(await probeSudo())) {
    console.error(`
Passwordless sudo for 'systemctl restart arduino-router' is not configured
on the Q. On the UNO Q, run:

  sudo visudo -f /etc/sudoers.d/arduino-router

And add this single line:

  arduino ALL=(root) NOPASSWD: /bin/systemctl restart arduino-router

Then rerun this script.
`);
    process.exit(1);
  }
} catch (err) {
  console.error(`Sudo probe failed: ${err.message}`);
  process.exit(1);
}

try {
  let exitCode = 0;
  const runs = [];

  for (const c of cases) {
    console.log(`\n\n########  Transport: ${c.name} (${c.label})  ########`);
    const idResult = await runScenario(c, 'Idempotent retry', true);
    // Let the router stabilize between scenarios.
    await new Promise((r) => setTimeout(r, 3000));
    const noResult = await runScenario(c, 'No retry (default)', false);
    runs.push({ transport: c.name, idResult, noResult });
    // Stabilise again before the next transport's round (if any).
    if (c !== cases[cases.length - 1]) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  console.log('\n=== Verdict ===');
  for (const r of runs) {
    const c = reportVerdict(r.transport, r.idResult, r.noResult);
    if (c !== 0) exitCode = c;
  }

  process.exit(exitCode);
} catch (err) {
  console.error('\nFatal:', err);
  process.exit(1);
}
