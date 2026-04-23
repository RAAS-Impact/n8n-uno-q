/**
 * SocketTransport — shared implementation for net.Socket-backed transports.
 *
 * UnixSocketTransport, TcpTransport, and TlsTransport differ only in how the
 * socket is created and which event signals readiness. The rest — promise-
 * based connect, data/close/error wiring, write(), graceful close — is
 * identical and lives here.
 */
import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { Transport } from './transport.js';

export abstract class SocketTransport extends EventEmitter implements Transport {
  private socket: net.Socket | null = null;

  /** Build a fresh net.Socket for a (re)connection. Each subclass supplies its own connect args. */
  protected abstract createSocket(): net.Socket;

  /**
   * The socket event that signals "ready to carry user data."
   *
   * - Plain TCP / unix → 'connect' (TCP handshake complete).
   * - TLS             → 'secureConnect' (TLS handshake complete). 'connect'
   *                     fires earlier, before the handshake — writing at that
   *                     point would put plaintext bytes onto the wire.
   */
  protected readyEvent(): string {
    return 'connect';
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = this.createSocket();
      const readyEvent = this.readyEvent();
      let settled = false;

      const onReady = () => {
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
        socket.off(readyEvent, onReady);
        // Destroy so the OS socket is released; no 'close' will be forwarded
        // (we haven't wired stream handlers yet).
        socket.destroy();
        reject(err);
      };

      socket.once(readyEvent, onReady);
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
