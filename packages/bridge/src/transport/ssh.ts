/**
 * SshTransport — Transport backed by a Duplex stream produced externally
 * (typically an `ssh2.Channel` from a `forwardOut` call on an SSH session
 * that the Q itself opened to an n8n-side listener).
 *
 * Shape differs from the socket-based transports: there is no host/port
 * to dial here. The connect-factory passed at construction time is what
 * produces the Duplex; this Transport just wires the data/close/error
 * events and exposes the standard Transport contract on top.
 *
 * Used for Variant B (reverse-SSH relay). The connect-factory comes from
 * the n8n-side singleton that owns the embedded SSH server — see
 * docs/master-plan/14-relay-ssh.md.
 */
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import type { Transport } from './transport.js';

export interface SshTransportOptions {
  /**
   * Returns a Duplex stream wired to the remote endpoint. Called once per
   * `connect()` — Bridge calls connect on the same Transport instance for
   * every (re)connect, so the factory may be invoked multiple times across
   * a Bridge's lifetime.
   *
   * Errors during stream acquisition (server not running, deviceNick not in
   * registry, transient SSH channel failures) must reject the returned
   * Promise so Bridge sees them as connect errors and applies its
   * exponential-backoff reconnect strategy.
   */
  connect: () => Promise<Duplex>;
}

export class SshTransport extends EventEmitter implements Transport {
  private stream: Duplex | null = null;

  constructor(private readonly opts: SshTransportOptions) {
    super();
  }

  async connect(): Promise<void> {
    const stream = await this.opts.connect();
    // Wire BEFORE storing — if a synchronous error fires inside .on() we
    // still surface it through the Transport's normal channels.
    stream.on('data', (chunk: Buffer) => this.emit('data', new Uint8Array(chunk)));
    stream.on('close', () => {
      if (this.stream === stream) this.stream = null;
      this.emit('close');
    });
    stream.on('error', (err: Error) => this.emit('error', err));
    this.stream = stream;
  }

  write(bytes: Uint8Array): boolean {
    if (!this.stream || this.stream.destroyed) return false;
    return this.stream.write(bytes);
  }

  async close(): Promise<void> {
    const stream = this.stream;
    if (!stream || stream.destroyed) {
      this.stream = null;
      return;
    }
    return new Promise<void>((resolve) => {
      stream.once('close', () => resolve());
      stream.end();
    });
  }
}
