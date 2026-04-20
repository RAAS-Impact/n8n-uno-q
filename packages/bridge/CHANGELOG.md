# Changelog

All notable changes to `@raasimpact/arduino-uno-q-bridge` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
