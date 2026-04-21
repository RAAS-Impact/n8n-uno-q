// Smoke test: connect to arduino-router and call $/version.
//
// Two transports:
//
//   A. Unix socket (default, legacy)
//      1. In a separate terminal, open the SSH tunnel:
//           rm -f /tmp/arduino-router.sock
//           ssh -N -L /tmp/arduino-router.sock:/var/run/arduino-router.sock arduino@linucs.local
//      2. In this terminal:
//           UNOQ_SOCKET=/tmp/arduino-router.sock node experiments/test-router.mjs
//      3. Stop the tunnel with Ctrl-C in the first terminal when done.
//
//   B. TCP (for the Variant A relay container — CONTEXT.md §12.5.1, §12.7 step 1)
//      1. On the Q, bring up the relay container:
//           cd ~/n8n/relay && docker compose up -d
//      2. In a separate terminal, forward the Q's loopback TCP port to the PC:
//           ssh -N -L 5775:localhost:5775 arduino@linucs.local
//      3. In this terminal:
//           UNOQ_TCP_HOST=127.0.0.1 UNOQ_TCP_PORT=5775 node experiments/test-router.mjs

import net from 'node:net';
import { encode, decodeMultiStream } from '@msgpack/msgpack';

const SOCKET = process.env.UNOQ_SOCKET;
const TCP_HOST = process.env.UNOQ_TCP_HOST;
const TCP_PORT = process.env.UNOQ_TCP_PORT;

let socket;
if (TCP_HOST && TCP_PORT) {
  console.log(`→ connecting via TCP ${TCP_HOST}:${TCP_PORT}`);
  socket = net.createConnection({ host: TCP_HOST, port: Number(TCP_PORT) });
} else if (SOCKET) {
  console.log(`→ connecting via unix socket ${SOCKET}`);
  socket = net.createConnection(SOCKET);
} else {
  console.error('Set UNOQ_SOCKET (unix) or UNOQ_TCP_HOST + UNOQ_TCP_PORT (tcp).');
  process.exit(1);
}

socket.on('connect', () => {
  console.log('→ sending $/version request');
  socket.write(encode([0, 1, '$/version', []]));
});

for await (const msg of decodeMultiStream(socket)) {
  console.log('← received:', msg);
  socket.end();
  break;
}
