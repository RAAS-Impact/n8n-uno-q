# Changelog

All notable changes to `@raasimpact/arduino-uno-q-bridge` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
