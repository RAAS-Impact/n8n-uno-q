// Smoke test: connect to arduino-router via Unix socket and call $/version
//
// Usage:
//   1. In a separate terminal, open the SSH tunnel and leave it running:
//        rm -f /tmp/arduino-router.sock
//        ssh -N -L /tmp/arduino-router.sock:/var/run/arduino-router.sock arduino@linucs.local
//   2. In this terminal, run the smoke test:
//        UNOQ_SOCKET=/tmp/arduino-router.sock node experiments/test-router.mjs
//   3. Stop the tunnel with Ctrl-C in the first terminal when done.

import net from 'node:net';
import { encode, decodeMultiStream } from '@msgpack/msgpack';

const SOCKET = process.env.UNOQ_SOCKET;
if (!SOCKET) { console.error('Set UNOQ_SOCKET to the local tunnel path, e.g. /tmp/arduino-router.sock'); process.exit(1); }

const socket = net.createConnection(SOCKET);
socket.on('connect', () => {
  console.log('→ sending $/version request');
  socket.write(encode([0, 1, '$/version', []]));
});

for await (const msg of decodeMultiStream(socket)) {
  console.log('← received:', msg);
  socket.end();
  break;
}
