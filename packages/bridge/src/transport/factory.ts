import type { Transport, TransportDescriptor } from './transport.js';
import { UnixSocketTransport } from './unix-socket.js';
import { TcpTransport } from './tcp.js';

/** Construct the right Transport for a descriptor. */
export function createTransport(descriptor: TransportDescriptor): Transport {
  switch (descriptor.kind) {
    case 'unix':
      return new UnixSocketTransport({ socketPath: descriptor.path });
    case 'tcp':
      return new TcpTransport({ host: descriptor.host, port: descriptor.port });
  }
}
