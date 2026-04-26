# Changelog

All notable changes to `n8n-nodes-uno-q` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-04-26

Reverse-SSH transport (Variant B) — for NAT-ed Qs that can dial out but can't accept inbound connections — added as a fourth `transport` value on the existing `Arduino UNO Q Router` credential. Bumped bridge dep to `^0.4.0` for `SshTransport` and the new close-time drain + `$/reset` behaviour that keeps MCU code from hanging when an n8n bridge closes with work in flight.

### Added

- **Reverse-SSH transport mode** on the `Arduino UNO Q Router` credential. Selectable from the same dropdown as the Unix / TCP / mTLS variants. Configuration: a listen address + port the n8n side binds, the host private key the embedded SSH server presents, the user CA public key it trusts, and a `Required principal` (defaults to `tunnel`). Routing is by user-cert KeyID — the only n8n-side routing key per [master plan §14.4](https://github.com/raas-impact/n8n-uno-q/blob/main/docs/master-plan/14-relay-ssh.md). Q-side autossh container ships separately under [`deploy/relay-ssh/`](deploy/relay-ssh/).
- **Process-singleton `SshServer`** that accepts inbound connections from Q autossh clients, validates user certs against a single CA, evicts zombie reconnects when a new client claims the same KeyID, and exposes `connect(deviceNick)` to nodes — opens a `forwarded-tcpip` channel back through the SSH session and returns the Duplex for `SshTransport` to wrap. Like `BridgeManager`, stashes itself on `globalThis` under a `Symbol.for(...)` key so each esbuild bundle of a node file shares the same instance at process scope.
- **`sshCertParser`** — manual OpenSSH user-cert parser + ed25519 signature verification, written because ssh2 v1.17 doesn't surface user certs through its `parseKey` API. Validates KeyID, principals, validity window, extensions (`permit-port-forwarding` required), and rejects any unrecognised critical option per the OpenSSH spec.
- **`Test Connection` for the SSH transport** runs the standard `$/version` round-trip end-to-end through the spawned forward, surfacing transport-specific failures (no device registered, cert rejected, host key mismatch) as legible messages at credential save rather than at first execution.
- **`BridgeManager` connection-pool entry for the `'ssh'` descriptor kind** — keyed by `(listenAddress, listenPort, deviceNick)` so the same Q reached from two nodes shares one Bridge, while two Qs on the same listener share the listener but get separate Bridges. The SshServer is brought up lazily when the first SSH-mode credential acquires, and torn down when the last reference drops.

### Changed

- **Bumped `@raasimpact/arduino-uno-q-bridge` to `^0.4.0`** — required for `SshTransport`. The same bump also brings in the close-time drain + `$/reset` behaviour that prevents MCU code from hanging when a bridge closes with router-forwarded requests in flight (relevant whenever a workflow saves, an agent deactivates, or n8n restarts mid-call).

## [0.3.0] — 2026-04-25

Multi-Q release: a single n8n instance can now drive several UNO Qs (locally and remotely) by assigning a different `Arduino UNO Q Router` credential to each node, including remote Qs reached over plain TCP or mTLS via the relay containers shipped under `deploy/relay/` and `deploy/relay-mtls/`.

### Added

- **`Arduino UNO Q Router` credential type** — replaces the implicit per-package socket path with a per-node credential. Three transport modes selectable from a dropdown:
  - **Unix Socket (local)** — same-host, default `/var/run/arduino-router.sock`.
  - **TCP (plain)** — Variant A relay, trusted LAN.
  - **TCP + mTLS** — Variant C relay, untrusted networks. Three PEM fields (CA, client cert, client key) appear when *Use TLS* is on; the n8n credential store keeps the key encrypted at rest.
  - **Test Connection** runs `$/version` over the configured transport and surfaces a transport-specific failure message (socket not found, TLS handshake failure, connection refused, …) rather than a generic error.
- **Multi-Q workflows** — assign different credentials to different nodes in the same workflow to read sensors on one Q and fire actuators on another. The `BridgeManager` singleton now keys its connection pool by transport descriptor, refcounts subscriptions per `(descriptor, method)`, and tears each connection down independently when its subscriber count hits zero.
- **`transport-resolver`** module that turns a credential payload into a `TransportDescriptor` consumed by the bridge, with explicit validation for the mTLS PEM trio.
- **Diagnostic snapshots** in `BridgeManager` (entries-by-descriptor, refcounts, pending close state) for troubleshooting connection-pool issues against a remote Q.

### Changed

- **All four nodes** (`Arduino UNO Q Call`, `Arduino UNO Q Trigger`, `Arduino UNO Q Respond`, `Arduino UNO Q Method`) now require a credential assignment. Existing workflows configured before 0.3.0 will need a one-time credential creation per Q. *Test Connection* on the credential surfaces the same failure messages each node will produce later, so misconfiguration is caught at credential save, not at first execution.
- Bumped `@raasimpact/arduino-uno-q-bridge` peer dependency to `^0.3.0` — required for the new TCP / mTLS transports.

### Fixed

- **`BridgeManager` refcount leaks** — the previous behaviour could double-decrement a refcount when a `provide` registration failed mid-handshake, eventually pinning a transport entry that should have been torn down. Refcounts now restore on every error path.
- **Request-mode single-owner invariant** — a Trigger node configured in synchronous response mode is the only owner of its method's bridge subscription; a second node trying to claim the same method now errors at registration instead of silently sharing the channel and producing intermittent missed responses.
- **Credential UI masking** — the TLS PEM fields render as multi-line text (not password-masked single-line), preserving whitespace exactly so the PEM parser sees what the user pasted.

## [0.2.1] — 2026-04-20

### Added

- **UnoQTool — Rate Limit** collection (`Max Calls` + `Per` of minute / hour /
  day). Caps how often the AI Agent may invoke the tool; excess calls
  short-circuit with a structured rejection `{ refused: true, error: "Refused:
  rate limit of N per <window> exceeded. Retry in ~Xs." }` that the LLM reads
  and can react to. The check runs before the Method Guard, and the call is
  recorded only after both gates pass — so guard-rejected calls do not consume
  rate-limit budget. Counters are a sliding window kept in-memory per n8n
  process (reset on container restart, not shared across queue-mode workers,
  which remains unsupported for the same reason the bridge singleton is).
- **`budget` variable in Method Guard scope** — a read-only view of the call
  history for traffic-aware policies. `budget.used(window)` returns prior
  successful calls in the last `'minute' | 'hour' | 'day'` and works whether
  or not a Rate Limit is configured, so guards can implement soft caps
  without committing to hard enforcement. `budget.remaining` and
  `budget.resetsInMs` expose cap-aware state when the Rate Limit field is set
  (number / number) and are `null` otherwise — enabling patterns like priority
  reservation ("refuse low-priority params when `remaining < 3`"). Exposed via
  `new Function('method', 'params', 'budget', <guard body>)`.

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
