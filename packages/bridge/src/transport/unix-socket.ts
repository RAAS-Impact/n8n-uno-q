import net from 'node:net';
import { SocketTransport } from './socket-base.js';

export interface UnixSocketTransportOptions {
  socketPath: string;
}

export class UnixSocketTransport extends SocketTransport {
  constructor(private readonly opts: UnixSocketTransportOptions) {
    super();
  }

  protected createSocket(): net.Socket {
    return net.createConnection(this.opts.socketPath);
  }
}
