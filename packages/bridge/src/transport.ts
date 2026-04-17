/**
 * transport.ts — Low-level socket wrapper with automatic reconnection.
 *
 * This is the layer between Bridge and the OS socket. It handles:
 * - Opening a Unix socket connection to the arduino-router
 * - Emitting raw data chunks (which the Bridge feeds into StreamDecoder)
 * - Automatic reconnection with exponential backoff when the socket drops
 *
 * The Bridge never touches net.Socket directly — it goes through Transport,
 * which means reconnection logic is isolated here and the Bridge only cares
 * about send/receive/lifecycle events.
 */
import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { ReconnectOptions } from './bridge.js';

export interface TransportEvents {
  data: (chunk: Uint8Array) => void;
  connect: () => void;
  close: () => void;
  error: (err: Error) => void;
}

export class Transport extends EventEmitter {
  private socket: net.Socket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  /** When true, we've been intentionally closed — don't reconnect. */
  private closed = false;

  constructor(
    private readonly socketPath: string,
    private readonly reconnect: ReconnectOptions,
  ) {
    super();
  }

  /** Initiate the first connection. */
  connect(): void {
    this.closed = false;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.closed) return;

    const socket = net.createConnection(this.socketPath);
    this.socket = socket;

    socket.on('connect', () => {
      this.reconnectAttempt = 0; // reset backoff on success
      this.emit('connect');
    });

    // Forward raw bytes to the Bridge (which feeds them into StreamDecoder)
    socket.on('data', (chunk: Buffer) => {
      this.emit('data', new Uint8Array(chunk));
    });

    socket.on('close', () => {
      this.emit('close');
      // Auto-reconnect unless we were intentionally closed
      if (!this.closed && this.reconnect.enabled) {
        this.scheduleReconnect();
      }
    });

    socket.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  /**
   * Schedule a reconnection with exponential backoff.
   * Delay doubles each attempt: baseDelay, baseDelay*2, baseDelay*4, ...
   * capped at maxDelay. Resets to baseDelay on successful connect.
   */
  private scheduleReconnect(): void {
    const delay = Math.min(
      this.reconnect.baseDelayMs * 2 ** this.reconnectAttempt,
      this.reconnect.maxDelayMs,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.doConnect(), delay);
  }

  /** Write raw bytes to the socket. Returns false if socket is unavailable. */
  write(data: Uint8Array): boolean {
    if (!this.socket || this.socket.destroyed) return false;
    return this.socket.write(data);
  }

  /** Gracefully close the socket and cancel any pending reconnect. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    return new Promise((resolve) => {
      if (!this.socket || this.socket.destroyed) {
        resolve();
        return;
      }
      this.socket.once('close', () => resolve());
      this.socket.end();
    });
  }
}
