/**
 * Transport — low-level socket abstraction.
 *
 * Bridge owns the reconnect loop (exponential backoff + subscription replay
 * live in bridge.ts). Transport is a thin, re-connectable wrapper around a
 * single OS-level socket: construct → connect() → [data/close/error events]
 * → close(). After a 'close' event or close() call, connect() may be invoked
 * again on the same instance to establish a fresh socket — Bridge uses this
 * for reconnection.
 *
 * Error contract:
 *   - Pre-connect failures (ECONNREFUSED, ENOENT on a unix path, DNS failure
 *     for a TCP host, etc.) surface via connect()'s Promise rejection. No
 *     'error' event fires for these.
 *   - Post-connect stream-level errors surface via the 'error' event and are
 *     typically followed by 'close'.
 */
import type { EventEmitter } from 'node:events';

/** Canonical description of a transport endpoint. */
export type TransportDescriptor =
  | { kind: 'unix'; path: string }
  | { kind: 'tcp'; host: string; port: number }
  /**
   * TLS with client-certificate authentication (mTLS). ca/cert/key are PEM
   * strings. Used to reach a remote UNO Q via the Variant C stunnel relay
   * when the LAN is untrusted. See CONTEXT.md §12.5.3.
   */
  | {
      kind: 'tls';
      host: string;
      port: number;
      ca: string;
      cert: string;
      key: string;
    };

export interface Transport extends EventEmitter {
  /**
   * Open the underlying socket. Resolves once the peer has accepted the
   * connection. Rejects on connection failure.
   */
  connect(): Promise<void>;
  /** Write raw bytes. Returns false if the socket is unavailable or destroyed. */
  write(bytes: Uint8Array): boolean;
  /** Close the socket gracefully. Idempotent. */
  close(): Promise<void>;

  on(event: 'data', listener: (chunk: Uint8Array) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

/** A short human-readable description of a descriptor, useful for logs and keying. */
export function describeTransport(d: TransportDescriptor): string {
  switch (d.kind) {
    case 'unix':
      return `unix:${d.path}`;
    case 'tcp':
      return `tcp:${d.host}:${d.port}`;
    case 'tls':
      // Distinct prefix from 'tcp' so BridgeManager treats tcp://host:port and
      // tls://host:port as separate connections (they are — one is plaintext,
      // the other mTLS). Cert material is intentionally excluded from the key
      // so credential edits that rotate keys but keep the same endpoint don't
      // pointlessly churn the connection pool.
      return `tls:${d.host}:${d.port}`;
  }
}
