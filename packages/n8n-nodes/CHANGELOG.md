# Changelog

All notable changes to `n8n-nodes-uno-q` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-04-20

### Fixed

- `BridgeManager` serializes `acquire()` and `getBridge()` after a prior
  `release()` by awaiting the background close. Rapid deactivate / reactivate
  cycles on the same method previously left two connections briefly overlapping
  on the router, causing the new `$/register` to be rejected with a
  "method already registered" error on workflow reactivation.

### Changed

- Bumps dependency on `@raasimpact/arduino-uno-q-bridge` to `^0.1.1` to pick
  up the bridge's new `disconnect` event and orphan-handler cleanup on socket
  close.

## [0.1.0] — 2026-04-19

- Initial publish.
