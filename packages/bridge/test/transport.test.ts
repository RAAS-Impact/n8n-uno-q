/**
 * transport unit tests — covers the plumbing that has no dedicated tests
 * elsewhere: describeTransport's keying, createTransport's routing, and
 * TlsTransport's construction shape.
 *
 * Real round-trip coverage for each transport is in the integration tests
 * (gated on UNOQ_SOCKET / UNOQ_TCP_* / UNOQ_TLS_* env vars). Unit tests
 * here are fast and don't need network or certs.
 */
import { describe, expect, it } from 'vitest';
import {
  createTransport,
  describeTransport,
  TcpTransport,
  TlsTransport,
  UnixSocketTransport,
} from '../src/transport/index.js';

describe('describeTransport', () => {
  it('renders unix descriptors', () => {
    expect(describeTransport({ kind: 'unix', path: '/var/run/foo.sock' })).toBe(
      'unix:/var/run/foo.sock',
    );
  });

  it('renders tcp descriptors', () => {
    expect(describeTransport({ kind: 'tcp', host: 'kitchen.local', port: 5775 })).toBe(
      'tcp:kitchen.local:5775',
    );
  });

  it('renders tls descriptors with a distinct prefix from tcp', () => {
    const key = describeTransport({
      kind: 'tls',
      host: 'kitchen.local',
      port: 5775,
      ca: '---CA---',
      cert: '---CERT---',
      key: '---KEY---',
    });
    expect(key).toBe('tls:kitchen.local:5775');
    // Same host:port on plain TCP produces a different key — BridgeManager
    // must dedupe these separately.
    expect(key).not.toBe(
      describeTransport({ kind: 'tcp', host: 'kitchen.local', port: 5775 }),
    );
  });

  it('omits cert material from the tls key so rotating keys on the same endpoint does not churn the connection pool', () => {
    const a = describeTransport({
      kind: 'tls',
      host: 'kitchen.local',
      port: 5775,
      ca: 'CA-v1',
      cert: 'CERT-v1',
      key: 'KEY-v1',
    });
    const b = describeTransport({
      kind: 'tls',
      host: 'kitchen.local',
      port: 5775,
      ca: 'CA-v2',
      cert: 'CERT-v2',
      key: 'KEY-v2',
    });
    expect(a).toBe(b);
  });
});

describe('createTransport', () => {
  it('returns UnixSocketTransport for a unix descriptor', () => {
    expect(createTransport({ kind: 'unix', path: '/tmp/x.sock' })).toBeInstanceOf(
      UnixSocketTransport,
    );
  });

  it('returns TcpTransport for a tcp descriptor', () => {
    expect(createTransport({ kind: 'tcp', host: 'h', port: 1 })).toBeInstanceOf(
      TcpTransport,
    );
  });

  it('returns TlsTransport for a tls descriptor', () => {
    const t = createTransport({
      kind: 'tls',
      host: 'h',
      port: 1,
      ca: 'CA',
      cert: 'CERT',
      key: 'KEY',
    });
    expect(t).toBeInstanceOf(TlsTransport);
  });
});

describe('TlsTransport', () => {
  it('constructs without opening a socket', () => {
    // Previously TcpTransport had the same invariant: new TcpTransport(...)
    // must not trigger DNS or TCP. TlsTransport must match — constructor
    // side effects would break the "build descriptor → connect later" flow
    // Bridge relies on for reconnect.
    const t = new TlsTransport({
      host: 'nonexistent.invalid',
      port: 0,
      ca: 'CA',
      cert: 'CERT',
      key: 'KEY',
    });
    expect(t).toBeInstanceOf(TlsTransport);
  });
});
