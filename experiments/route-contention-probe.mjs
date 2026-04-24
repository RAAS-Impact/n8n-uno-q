#!/usr/bin/env node
// Route-contention probe: deterministically characterises what arduino-router
// does when two clients both $/register the same Request-mode method.
//
// Purpose: resolve a real incident where two n8n instances (Q + laptop) tried
// to own gpio_event on the same router, one got "route already exists", then
// the MCU's Bridge.call() hung with nobody answering. The hang means nobody
// is actually handling the route — but which of these is the router doing?
//
//   H1. Last-writer-wins: silently rehands ownership to the second caller
//       while returning an error response (the error is a lie).
//   H2. Duplicate invalidates: rejects the second AND clears the original —
//       ends up with nobody owning.
//   H3. Stale-alive: registration is technically held but the socket behind
//       it is dead-from-the-router's-perspective.
//
// The probe wires three independent Bridge instances into the same router,
// drives a controlled sequence, and prints what actually happens. No n8n,
// no MCU — just the router and us.
//
// Usage — same transport conventions as experiments/test-router.mjs:
//
//   A. Unix socket (SSH-tunneled from the Q):
//        rm -f /tmp/arduino-router.sock
//        ssh -N -L /tmp/arduino-router.sock:/var/run/arduino-router.sock arduino@linucs.local
//      Then:
//        npm run build -w packages/bridge
//        UNOQ_SOCKET=/tmp/arduino-router.sock node experiments/route-contention-probe.mjs
//
//   B. TCP (Variant A relay, plaintext — NOT mTLS):
//        # on the Q: cd ~/n8n/relay && docker compose up -d
//        ssh -N -L 5775:localhost:5775 arduino@linucs.local
//      Then:
//        UNOQ_TCP_HOST=127.0.0.1 UNOQ_TCP_PORT=5775 node experiments/route-contention-probe.mjs
//
// The probe cleans up after itself (closes all three bridges) on success or
// failure. If it gets wedged, Ctrl-C and inspect the router journal.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeDist = path.resolve(here, '../packages/bridge/dist/index.js');
if (!existsSync(bridgeDist)) {
  console.error(`Bridge build not found at ${bridgeDist}`);
  console.error('Run: npm run build -w packages/bridge');
  process.exit(1);
}
const { Bridge } = await import(bridgeDist);

const SOCKET = process.env.UNOQ_SOCKET;
const TCP_HOST = process.env.UNOQ_TCP_HOST;
const TCP_PORT = process.env.UNOQ_TCP_PORT;

function describeTarget() {
  if (SOCKET) return `unix:${SOCKET}`;
  if (TCP_HOST && TCP_PORT) return `tcp:${TCP_HOST}:${TCP_PORT}`;
  return null;
}
const target = describeTarget();
if (!target) {
  console.error('Set UNOQ_SOCKET (unix) or UNOQ_TCP_HOST + UNOQ_TCP_PORT (tcp).');
  process.exit(1);
}

// Reconnect deliberately DISABLED — the probe is short-lived and we want any
// mid-probe socket oddity to surface as a hard error, not get papered over.
const RECONNECT = { enabled: false, baseDelayMs: 0, maxDelayMs: 0 };

function connect(label) {
  const opts = SOCKET
    ? { socket: SOCKET, reconnect: RECONNECT }
    : { transport: { kind: 'tcp', host: TCP_HOST, port: Number(TCP_PORT) }, reconnect: RECONNECT };
  const p = Bridge.connect(opts);
  return p.then((bridge) => {
    bridge.on('error', (err) => console.warn(`  [${label}] bridge error:`, err.message));
    return bridge;
  });
}

// Namespace the method so a failed probe run doesn't poison a real method
// (unlikely in practice — this is for dev).
const METHOD = `probe_route_contention_${Date.now()}`;

const horiz = () => console.log('─'.repeat(72));
const banner = (s) => { horiz(); console.log(s); horiz(); };

async function main() {
  console.log(`Target: ${target}`);
  console.log(`Probe method: ${METHOD}`);
  horiz();

  console.log('Connecting three bridges (A owner, B contender, C caller)...');
  const [A, B, C] = await Promise.all([connect('A'), connect('B'), connect('C')]);
  console.log('  ✓ all three connected');

  const aCalls = [];
  const bCalls = [];
  let aHandlerFired = false;
  let bHandlerFired = false;

  // Track close events so we can correlate behaviour with socket state.
  for (const [name, br] of [['A', A], ['B', B], ['C', C]]) {
    br.on('disconnect', () => console.log(`  [${name}] disconnect event`));
  }

  try {
    banner('Step 1: A registers the method');
    await A.provide(METHOD, (params) => {
      aHandlerFired = true;
      aCalls.push(params);
      return 'from-A';
    });
    console.log('  ✓ A.provide resolved — A claims ownership');

    banner('Step 2: B tries to register the same method');
    let bError = null;
    try {
      await B.provide(METHOD, (params) => {
        bHandlerFired = true;
        bCalls.push(params);
        return 'from-B';
      });
      console.log('  ! B.provide RESOLVED (no error) — router silently accepted duplicate');
    } catch (err) {
      bError = err;
      console.log(`  ✓ B.provide threw: ${err.message}`);
    }

    banner('Step 3: C calls the method — who responds?');
    const start = Date.now();
    let cResult = null;
    let cError = null;
    try {
      cResult = await C.call(METHOD, 'hello-from-C');
    } catch (err) {
      cError = err;
    }
    const elapsed = Date.now() - start;

    console.log(`  elapsed: ${elapsed} ms`);
    if (cError) {
      console.log(`  C.call rejected: ${cError.message}`);
    } else {
      console.log(`  C.call result: ${JSON.stringify(cResult)}`);
    }
    console.log(`  A's handler fired: ${aHandlerFired} (${aCalls.length} call${aCalls.length === 1 ? '' : 's'})`);
    console.log(`  B's handler fired: ${bHandlerFired} (${bCalls.length} call${bCalls.length === 1 ? '' : 's'})`);

    banner('Diagnosis');
    if (cResult === 'from-A' && aHandlerFired && !bHandlerFired) {
      console.log('  ✅ HEALTHY: A still owns the route. H1/H2 both ruled out.');
      console.log('     The duplicate $/register was rejected cleanly without side effects.');
      console.log('     If the real incident still shows hang, root cause is elsewhere (likely');
      console.log('     client-side: bridge/manager thinks A is registered but providers map');
      console.log('     is out of sync with router).');
    } else if (cResult === 'from-B' && bHandlerFired && !aHandlerFired) {
      console.log('  ⚠️  H1 CONFIRMED: router SILENTLY handed ownership to B.');
      console.log('     B.provide error response was a lie — state was mutated anyway.');
      console.log('     Fix direction: after a failed $/register, the original owner cannot');
      console.log('     trust its cached state. Needs a verify/re-assert mechanism, or a');
      console.log('     router-side fix to stop mutating on rejection.');
    } else if (cError || elapsed > 2000) {
      console.log('  ⚠️  H2 CONFIRMED (or stale-alive): nobody responded to C.call.');
      console.log('     The duplicate $/register either cleared the original registration or');
      console.log('     left the router pointing at a dead socket. Matches the incident:');
      console.log('     MCU hangs because the router no longer has a deliverable route.');
      console.log('     Fix direction: client-side retry on rejection from the rightful owner,');
      console.log('     plus a router-side fix to make $/register conflict-safe.');
    } else {
      console.log('  ?  Unexpected combination — double-check interpretation:');
      console.log(`     cResult=${JSON.stringify(cResult)} cError=${cError?.message}`);
      console.log(`     aFired=${aHandlerFired} bFired=${bHandlerFired} elapsed=${elapsed}ms`);
    }

    banner('Step 4: close B and re-call — does A reclaim?');
    await B.close();
    // Give the router a moment to notice B's socket dropped.
    await new Promise((r) => setTimeout(r, 500));
    const aCountBefore = aCalls.length;
    let c2Result = null;
    let c2Error = null;
    const start2 = Date.now();
    try {
      c2Result = await C.call(METHOD, 'hello-again');
    } catch (err) {
      c2Error = err;
    }
    const elapsed2 = Date.now() - start2;
    console.log(`  elapsed: ${elapsed2} ms`);
    console.log(`  result: ${JSON.stringify(c2Result)} error: ${c2Error?.message ?? 'none'}`);
    console.log(`  A's handler fired this round: ${aCalls.length > aCountBefore}`);
    console.log(`  (A had ${aCountBefore} calls before, ${aCalls.length} after)`);
  } finally {
    banner('Cleanup');
    for (const [name, br] of [['A', A], ['B', B], ['C', C]]) {
      try {
        await br.close();
        console.log(`  ${name} closed`);
      } catch (err) {
        console.log(`  ${name} close failed: ${err.message}`);
      }
    }
  }
}

main().catch((err) => {
  console.error('Probe aborted:', err);
  process.exit(1);
});
