import type { Transport, TransportDescriptor } from './transport.js';
import { UnixSocketTransport } from './unix-socket.js';
import { TcpTransport } from './tcp.js';
import { TlsTransport } from './tls.js';

/**
 * Construct the right Transport for a descriptor.
 *
 * NOTE: 'ssh' is intentionally not handled here. Its Duplex stream comes
 * from a singleton managed outside packages/bridge (the n8n-side SSH
 * server in packages/n8n-nodes), so the caller MUST pass
 * `transportInstance` to Bridge.connect — which BridgeManager does. If
 * createTransport is reached with kind 'ssh', that's a wiring bug.
 */
export function createTransport(descriptor: TransportDescriptor): Transport {
  switch (descriptor.kind) {
    case 'unix':
      return new UnixSocketTransport({ socketPath: descriptor.path });
    case 'tcp':
      return new TcpTransport({ host: descriptor.host, port: descriptor.port });
    case 'tls':
      return new TlsTransport({
        host: descriptor.host,
        port: descriptor.port,
        ca: descriptor.ca,
        cert: descriptor.cert,
        key: descriptor.key,
      });
    case 'ssh':
      throw new Error(
        `createTransport: 'ssh' descriptor must be paired with a transportInstance ` +
          `(deviceNick='${descriptor.deviceNick}'). The n8n-side BridgeManager handles this; ` +
          `if you reached this from elsewhere, you need to construct an SshTransport manually.`,
      );
  }
}
