# Changelog

All notable changes to `n8n-nodes-uno-q` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-04-20

### Added

- **UnoQTool — Method Guard** field. Optional JavaScript body that runs at
  invocation time with `method` and `params` in scope, deciding whether the
  call may proceed. Typical uses: vetting LLM-supplied arguments, time-of-day
  gating, external-state checks. Return `true` / `undefined` / `null` to
  allow; return a string to reject with that exact message (surfaced as
  structured tool output `{ method, params, refused: true, error }` so the
  AI Agent feeds it back to the LLM for self-correction); return `false`
  for a generic rejection; throws surface as workflow errors prefixed
  `Method guard threw:` (reserved for genuine guard bugs). Uses n8n's
  `jsEditor` widget for syntax-highlighted input. No sandbox — same trust
  model as n8n's Code node.
- **UnoQTool — Idempotent** top-level checkbox driving bridge-level retry
  on mid-call `ConnectionError`. Fail-closed default (off).

### Changed

- **UnoQCall — Idempotent** moved from the *Options* collection to a
  top-level checkbox for consistency with UnoQTool and to keep the
  fail-closed flag visible enough to be overridden when appropriate.
  **Minor breaking**: workflows saved pre-0.2.0 with `options.idempotent:
  true` silently reset to the default `false` on load; re-tick at the top
  level. No runtime error — just quiet loss of the setting.
- Bumps dependency on `@raasimpact/arduino-uno-q-bridge` to `^0.2.0` for
  the new `callWithOptions` retry API.

### Removed

- Dropped the earlier `safeReadOnly` boolean (advisory, never read by the
  bridge) in favour of the Method Guard, which enforces per-invocation
  rather than signalling per-method.

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
