import net from 'node:net';
import { SocketTransport } from './socket-base.js';

export interface TcpTransportOptions {
  host: string;
  port: number;
}

export class TcpTransport extends SocketTransport {
  constructor(private readonly opts: TcpTransportOptions) {
    super();
  }

  protected createSocket(): net.Socket {
    return net.createConnection({ host: this.opts.host, port: this.opts.port });
  }
}
