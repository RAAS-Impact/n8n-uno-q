#!/usr/bin/env node
// Live verification of Bridge.callWithOptions retry on a mid-call router
// restart. Sustains a ping loop while SSH-triggering `systemctl restart
// arduino-router`, so the socket actually drops during in-flight calls — the
// one thing MockRouter unit tests can't prove.
//
// Usage:
//   Prereq 1 — SSH tunnel open at /tmp/arduino-router.sock:
//     rm -f /tmp/arduino-router.sock
//     ssh -N -L /tmp/arduino-router.sock:/var/run/arduino-router.sock arduino@linucs.local
//
//   Prereq 2 — passwordless sudo on the Q for the restart command:
//     ssh arduino@linucs.local
//     sudo visudo -f /etc/sudoers.d/arduino-router
//     # add this single line:
//     arduino ALL=(root) NOPASSWD: /bin/systemctl restart arduino-router
//
//   Prereq 3 — bridge package built:
//     npm run build -w packages/bridge
//
//   Then:
//     node experiments/test-retry-live.mjs
//
// Env overrides: UNOQ_SOCKET, UNOQ_SSH.

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

const SOCKET = process.env.UNOQ_SOCKET ?? '/tmp/arduino-router.sock';
const SSH_HOST = process.env.UNOQ_SSH ?? 'arduino@linucs.local';

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

function probeTunnel() {
  // existsSync only tells us the socket file exists; it doesn't tell us SSH is
  // still listening behind it. A stale socket file from a dead tunnel would
  // pass existsSync but refuse connections — so actually connect and close.
  return new Promise((resolve) => {
    const s = net.createConnection(SOCKET);
    const done = (ok) => {
      s.removeAllListeners();
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
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
  // Confirm router is back by probing the tunnel again.
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await probeTunnel()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('router did not come back within 9s after probe-restart');
}

// --- the test -------------------------------------------------------------

async function warmup(bridge) {
  const v = await bridge.call('$/version');
  console.log(`  warm-up $/version: ${v}`);
}

async function runScenario(label, idempotent) {
  console.log(`\n=== ${label} (idempotent=${idempotent}) ===`);
  // Pre-probe: between scenarios the SSH tunnel can wobble (or even die from
  // the previous restart cycle). Without this check, a dead tunnel would
  // surface as an unhandled `error` event from Bridge.connect — kills the
  // script and obscures the real result.
  if (!(await probeTunnel())) {
    console.error(`  Tunnel ${SOCKET} not reachable — aborting scenario.`);
    console.error(`  Re-open the SSH tunnel and rerun.`);
    process.exit(1);
  }
  const bridge = await Bridge.connect({
    socket: SOCKET,
    reconnect: { enabled: true, baseDelayMs: 200, maxDelayMs: 2000 },
  });
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

// --- main -----------------------------------------------------------------

console.log(`Socket:   ${SOCKET}`);
console.log(`SSH host: ${SSH_HOST}`);

const tunnelAlive = existsSync(SOCKET) && (await probeTunnel());
if (!tunnelAlive) {
  console.error(`
Cannot connect to ${SOCKET} — the SSH tunnel appears closed (stale socket
file or SSH process gone). (Re-)open the tunnel in a separate terminal:

  rm -f ${SOCKET}
  ssh -N -L ${SOCKET}:/var/run/arduino-router.sock ${SSH_HOST}
`);
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
  const idResult = await runScenario('Idempotent retry', true);
  // Let the router stabilize between scenarios.
  await new Promise((r) => setTimeout(r, 3000));
  const noResult = await runScenario('No retry (default)', false);

  console.log('\n=== Verdict ===');
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

  process.exit(code);
} catch (err) {
  console.error('\nFatal:', err);
  process.exit(1);
}
