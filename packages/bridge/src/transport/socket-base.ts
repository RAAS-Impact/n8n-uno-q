/**
 * SocketTransport — shared implementation for net.Socket-backed transports.
 *
 * Both UnixSocketTransport and TcpTransport differ only in how the net.Socket
 * is created. The rest — promise-based connect, data/close/error wiring,
 * write(), graceful close — is identical and lives here.
 */
import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { Transport } from './transport.js';

export abstract class SocketTransport extends EventEmitter implements Transport {
  private socket: net.Socket | null = null;

  /** Build a fresh net.Socket for a (re)connection. Each subclass supplies its own connect args. */
  protected abstract createSocket(): net.Socket;

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = this.createSocket();
      let settled = false;

      const onConnect = () => {
        if (settled) return;
        settled = true;
        socket.off('error', onError);
        this.socket = socket;
        this.wireStream(socket);
        resolve();
      };

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        socket.off('connect', onConnect);
        // Destroy so the OS socket is released; no 'close' will be forwarded
        // (we haven't wired stream handlers yet).
        socket.destroy();
        reject(err);
      };

      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
  }

  private wireStream(socket: net.Socket): void {
    socket.on('data', (chunk: Buffer) => this.emit('data', new Uint8Array(chunk)));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.emit('close');
    });
    socket.on('error', (err: Error) => this.emit('error', err));
  }

  write(bytes: Uint8Array): boolean {
    if (!this.socket || this.socket.destroyed) return false;
    return this.socket.write(bytes);
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      this.socket = null;
      return;
    }
    return new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.end();
    });
  }
}
