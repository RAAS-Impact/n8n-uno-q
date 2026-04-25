import net from 'node:net';
import tls from 'node:tls';
import { SocketTransport } from './socket-base.js';

export interface TlsTransportOptions {
  host: string;
  port: number;
  /** PEM-encoded CA certificate(s) used to verify the server. */
  ca: string;
  /** PEM-encoded client certificate presented to the server for mTLS. */
  cert: string;
  /** PEM-encoded private key matching `cert`. */
  key: string;
}

/**
 * mTLS transport — used to reach a remote UNO Q via the Variant C stunnel
 * relay (see docs/master-plan/12-multi-q.md §12.5.3). Reuses the shared SocketTransport base
 * because a tls.TLSSocket IS a net.Socket — only the ready-event name and
 * the socket constructor differ from plain TCP.
 *
 * Security: `rejectUnauthorized` is left at the default (true). Any server
 * cert not chaining to the supplied `ca` fails the handshake and surfaces
 * as a connect() rejection. SNI is sent automatically because Node infers
 * `servername` from `host` when it's absent.
 */
export class TlsTransport extends SocketTransport {
  constructor(private readonly opts: TlsTransportOptions) {
    super();
  }

  protected createSocket(): net.Socket {
    // tls.TLSSocket extends net.Socket, so the SocketTransport contract holds.
    return tls.connect({
      host: this.opts.host,
      port: this.opts.port,
      ca: this.opts.ca,
      cert: this.opts.cert,
      key: this.opts.key,
    });
  }

  protected readyEvent(): string {
    // 'connect' fires when the underlying TCP is established — before the TLS
    // handshake completes. We must wait for 'secureConnect' before writing
    // any application bytes, otherwise we'd leak plaintext or race the peer.
    return 'secureConnect';
  }
}
