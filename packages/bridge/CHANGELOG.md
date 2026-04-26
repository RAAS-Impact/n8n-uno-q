# Changelog

All notable changes to `@raasimpact/arduino-uno-q-bridge` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-04-26

Reverse-SSH transport + a robustness fix that prevents downstream MCU code from hanging when a bridge closes with work in flight.

### Added

- **`SshTransport`** — fourth transport, sitting on top of an externally-supplied Duplex stream rather than dialing a socket itself. Used by the Variant B reverse-SSH deployment ([master plan §14](https://github.com/raas-impact/n8n-uno-q/blob/main/docs/master-plan/14-relay-ssh.md)) where the n8n-side singleton owns the SSH server; the bridge just receives the forwardOut channel for one specific device. Construct with `new SshTransport({ connect: () => Promise<Duplex> })` and pass it to `Bridge.connect({ transportInstance })`.
- **`'ssh'` discriminant on `TransportDescriptor`** with `listenAddress`, `listenPort`, `deviceNick` (the cert KeyID — the only routing key on the n8n side per §14.4). The factory throws if a caller tries to construct an SSH transport from descriptor alone — the Duplex must come from the singleton, so `transportInstance` is mandatory for this kind.

### Changed

- **`Bridge.close()` now drains in-flight router-forwarded requests** before tearing down the transport. Each pending `provide` handler invocation gets an explicit `[1, "bridge closing while handling <method>"]` error response written to the wire, so any caller blocked on a synchronous reply (notably an MCU executing `Bridge.call(...)` inside its `loop()`) unblocks instead of hanging forever. The handler's own response writes use the in-flight Map's `delete` as a CAS guard to avoid double-sends.
- **`Bridge.close()` now sends `$/reset` to the router** (with a 500ms cap so a slow router doesn't block close) to drop every method this connection registered. Without this, the router kept routing for a dead socket; the next caller for one of those methods would either hang or surface a transport-layer error rather than a clean "method not available". Sent unconditionally because callers (tests, drift recovery paths) may have mutated `providers` directly, so local view ≠ router-side truth.

## [0.3.0] — 2026-04-25

Multi-transport release: `Bridge.connect()` now accepts plain TCP and mTLS in addition to the original Unix socket — wiring the bridge up to remote UNO Qs over a relay container without changing the call/notify/provide surface.

### Added

- **Plain TCP transport** — `Bridge.connect({ host, port })` for use with the Variant A `socat` relay on a trusted LAN. Same wire protocol as the Unix socket, just over a TCP stream.
- **mTLS transport** — `Bridge.connect({ host, port, tls: { ca, cert, key } })` for the Variant C `stunnel` relay. The bridge presents a client certificate and validates the server cert against the supplied CA. PEM strings are accepted inline; no filesystem path required.
- **`TransportDescriptor`** discriminated union (`{ kind: 'unix' | 'tcp' | 'tls', ... }`) — the `connect()` overloads compile down to this shape internally and it's exported for consumers (notably the n8n-nodes credential resolver) that need to round-trip a transport choice through configuration.
- **`disconnect` event reason payload** — the bridge surfaces *why* the socket dropped so consumers can distinguish a clean close from a network failure or a timeout.

### Changed

- The single-file `transport.ts` was split into a `transport/` directory (`unix-socket.ts`, `tcp.ts`, `tls.ts`, plus a `socket-base.ts` mixin and a `factory.ts` for descriptor → transport instantiation). Net behaviour preserved for existing Unix-socket callers; the new structure is what made TCP/TLS additions clean.

### Fixed

- **`[code, message]` error tuple format** — Arduino's `Arduino_RouterBridge` library returns errors as a `[code, message]` array rather than a string; the bridge now decodes both formats so msgpack-RPC errors raised by the MCU surface readably in the consumer instead of as opaque arrays.
- Requests for unregistered methods now respond with a structured error rather than dropping silently.

## [0.2.0] — 2026-04-20

### Added

- `Bridge.callWithOptions(method, params[], opts)` — new public entry point
  taking an `opts` bag (`{ timeoutMs, idempotent }`). When `idempotent: true`,
  an in-flight or about-to-start call that hits `ConnectionError` races the
  bridge's `reconnect` event against the remaining `timeoutMs` budget and
  retries — repeatedly, through cascading drop/reconnect cycles, until the
  call resolves or the budget runs out. Never retries on `TimeoutError` or
  for non-idempotent calls. Calls that *start* against a known-disconnected
  bridge fast-fail with `ConnectionError` so the retry path has something to
  react to rather than waiting out the full timeout on a destroyed socket.

### Changed

- `call(method, params[])` and `callWithTimeout(method, params[], timeoutMs)`
  are now thin wrappers over `callWithOptions` with `idempotent: false`.
  Behavior preserved for existing callers.

## [0.1.1] — 2026-04-20

### Added

- `disconnect` event emitted by `Bridge` whenever the transport socket drops.
  Consumers now have an explicit hook for cleaning up deferred state (pending
  promises, application-level request maps) instead of waiting for a response
  that will never arrive. Previously the close path was internal-only with no
  observable signal.

### Fixed

- In-flight `provide` handlers are cleared from `activeHandlers` when the
  socket closes mid-call. Previously orphaned handlers lingered in tracking
  after a mid-call drop, surviving reconnects and causing shutdown-drain
  paths to wait on handlers whose eventual RESPONSE had nowhere to land.

## [0.1.0] — 2026-04-19

- Initial publish.
