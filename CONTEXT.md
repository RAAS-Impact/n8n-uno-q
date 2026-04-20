# n8n-uno-q — Project context

> **Instructions for Claude Code:** read this file first, in full, before any other action in this repo. It captures all architectural decisions, verified facts about the target hardware, and the rationale behind them. Treat it as source of truth. When you make a decision that contradicts anything here, update this file in the same commit — don't let it drift.

---

## 1. What we're building

A bridge between **n8n** (workflow automation) and the **Arduino UNO Q's** microcontroller, so that n8n workflows can read sensors, drive GPIO, call I2C devices, and react to async events coming from the MCU.

The deliverable is **two published npm packages**:

1. **`@raasimpact/arduino-uno-q-bridge`** — a pure Node.js MessagePack-RPC client for `arduino-router`. No n8n dependency. Zero-dependency except `@msgpack/msgpack`. Useful on its own for anyone doing Node.js on a UNO Q (Express, Fastify, Bun, raw scripts).
2. **`n8n-nodes-uno-q`** — an n8n community package (conforming to the [official spec](https://docs.n8n.io/integrations/creating-nodes/build/reference/)) that depends on the package above and exposes Action, Trigger, and **Tool** nodes for n8n workflows. The Tool node makes MCU methods directly invokable by the [Tools AI Agent](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/tools-agent/) — so an LLM can decide when to read a sensor, fire an actuator, or inspect board state as part of reasoning.

**Roadmap beyond publishing:**

- Phase 1: package (1) — client library, publish to npm.
- Phase 2: package (2) — n8n community nodes, publish to npm and list on n8n's community nodes directory.
- Phase 3: PR upstream into [`arduino/app-bricks-py`](https://github.com/arduino/app-bricks-py) to get an **official n8n Brick** shipped in App Lab. The Brick will be a containerized n8n plus the community nodes package pre-installed.

The two npm packages are useful regardless of whether phase 3 succeeds — they're the reusable core. The Brick is packaging.

---

## 2. Architecture decision: direct to router, no Python proxy

`arduino-router` (the Go service running on the UNO Q) is a MessagePack-RPC hub. It exposes itself over Unix socket and serial, accepts standard msgpack-rpc clients in any language, and routes calls between them based on method names registered via `$/register`. **The `arduino.app_utils.Bridge` Python package is nothing more than a thin client on top of this**, not a privileged intermediary.

**Consequence:** Node.js can talk to the router directly. We do **not** need a Python proxy (which would have been the naïve approach — spawning a Python sidecar container that exposes HTTP/TCP to n8n and calls `Bridge.call` internally). Removing the proxy means:

- One less container to ship, configure, monitor.
- Lower latency (one hop instead of two).
- Async events (MCU → n8n) work natively via msgpack-rpc NOTIFY — no polling, no webhooks, no second protocol.
- n8n's trigger nodes can just `$/register` a method name and wait for calls.

**Earlier alternative (rejected):** talking to n8n via TCP JSON-line through a Python App Lab app that wraps `Bridge`. This is what [UNOQ_DoubleBridge](https://github.com/ffich/UNOQ_DoubleBridge) does for Node-RED. It works, but it's strictly a superset of what we need for a worse result. Rejected.

**Confirmation from Arduino team:** in the [forum thread about Node.js Bridge](https://forum.arduino.cc/t/uno-q-has-anyone-tried-using-the-bridge-with-node-js-instead-of-python/1410860), @manchuino (Arduino staff) explicitly endorsed this path: *"you need to implement an interface to the arduino-router in node.js the same way the bridge.py script does."*

---

## 3. Verified facts about my UNO Q (hostname: `linucs`)

All the following were checked on my physical board in April 2026. Don't assume they hold on other boards — re-verify before generalizing.

### Router process

```
root   596   /usr/bin/arduino-router \
             --unix-port /var/run/arduino-router.sock \
             --serial-port /dev/ttyHS1 \
             --serial-baudrate 115200
```

- Runs as **root** at system boot (probably via systemd unit).
- **No TCP listener** — only Unix socket. So we ignore `msgpack-rpc-router:host-gateway` tricks.
- Router version reported by `$/version`: **`0.8.0`** (was `0.5.4` in February 2026; protocol is stable across versions).
- The `--monitor-port` flag (defaults to `127.0.0.1:7500`) is a separate MCU monitor proxy, unrelated to our RPC usage.

### Socket

```
srw-rw-rw- 1 root root   0 Feb 22 07:24 /var/run/arduino-router.sock
```

- **World-writable** (`0666`) — any user/container can read and write.
- Owned by root but the mode takes precedence. No need for user/group workarounds when running containers.

### MCU transport

- Serial: `/dev/ttyHS1` @ 115200, 8N1.
- Managed exclusively by the router. **Never open this device manually** — the router owns it and competing for it will break everything.

### App storage

- App Lab is a **remote editor**: source code lives on the UNO Q, not on the PC. A firmware update wipes all user apps. → **git on the PC is the source of truth, always.**
- On the UNO Q, apps live under `/home/arduino/arduinoApps/` (exact capitalization may vary between `arduinoApps` / `ArduinoApps` / `Arduino Apps` depending on App Lab version — check `ls /home/arduino/` when in doubt).

### Open hardware question

- **Which UNO Q variant do I own, 2 GB or 4 GB?** Check `free -h` on the board. n8n + router + OS sits comfortably on 4 GB. On 2 GB we might have to be more frugal (lean n8n image, fewer concurrent workflows). TODO: verify and record in a `hardware.md` note.

---

## 4. Protocol reference

### Transport

- Unix socket: `/var/run/arduino-router.sock`. Bind-mount into containers with `-v /var/run/arduino-router.sock:/var/run/arduino-router.sock` — this is the only connection method we use.
- Message framing: **raw msgpack values back-to-back**, no length prefix. Use a streaming decoder (e.g., `@msgpack/msgpack` `Decoder` with `.decodeMulti()`) that can read one value at a time.

### Message shapes (MessagePack-RPC spec)

- **REQUEST**: `[0, msgid, method_name, params_array]` — expects a RESPONSE.
- **RESPONSE**: `[1, msgid, error, result]` — `error` is `null` on success, a string (or array) describing the failure otherwise.
- **NOTIFY**: `[2, method_name, params_array]` — fire-and-forget, no `msgid`, no response.

### Arduino-specific methods (the only non-standard bit)

- **`$/register <method_name>`** — advertise that you handle calls to `method_name`. Returns `true` on success, error string if the name is already taken.
- **`$/reset`** — drop all methods registered by this connection.
- **`$/version`** — returns router version as string.
- **`$/serial/open`** / **`$/serial/close`** — manage the MCU serial connection. Don't touch these; the router handles it.
- **`$/setMaxMsgSize <bytes>`** — per-router message size cap.

### Flow reference

```
Client A registers "foo":
  A → Router: [0, 50, "$/register", ["foo"]]
  Router → A: [1, 50, null, true]

Client B calls "foo":
  B → Router:       [0, 32, "foo", [1, true]]
  Router → A:       [0, 51, "foo", [1, true]]          (router remaps msgid)
  A → Router:       [1, 51, null, "result"]
  Router → B:       [1, 32, null, "result"]            (router remaps back)

MCU fires an async event (NOTIFY path):
  MCU → Router:     [2, "button_pressed", [3, "rising"]]
  Router → trigger: [2, "button_pressed", [3, "rising"]]   (if a client registered it)
```

When a client disconnects, all its registrations are dropped automatically. Plan reconnection/re-registration logic in the client around this.

---

## 5. Package 1 — `@raasimpact/arduino-uno-q-bridge`

**Status: implemented and publish-ready.** Source, tests, README, LICENSE all in place.

### Scope and shape

- Pure Node.js, ES modules, TypeScript source, publishes both ESM and types.
- Single dependency: `@msgpack/msgpack`.
- License: MIT.

### Public API (implemented)

```ts
import { Bridge } from '@raasimpact/arduino-uno-q-bridge';

const bridge = await Bridge.connect({
  socket: '/var/run/arduino-router.sock',  // default
  reconnect: { enabled: true, baseDelayMs: 200, maxDelayMs: 5000 },
});

// Outbound call — router forwards to whoever registered this method
const answer = await bridge.call('set_led_state', true);
const answer = await bridge.callWithTimeout('slow_op', 10_000);
bridge.notify('fire_and_forget', 'hello');

// Inbound: register ourselves as the handler of a name
await bridge.provide('log_from_linux', async (params, msgid) => {
  console.log('MCU says:', params);
  return 'ok';
});

// Inbound notifications (MCU → us, fire-and-forget)
// Returns an unsubscribe function
const unsub = await bridge.onNotify('button_pressed', (params) => { /* ... */ });

// Lifecycle
bridge.on('reconnect', () => { /* providers and notify subs are re-registered automatically */ });
bridge.on('error', (err) => { /* log */ });
await bridge.close();
```

### Behaviours implemented

- **msgid allocation** — monotonic counter wrapping at 2³¹. In-flight requests tracked in `Map<msgid, {resolve, reject, timer}>`.
- **Timeouts** — default 5s via `call()`, custom via `callWithTimeout()`. All pending rejected on socket close.
- **Automatic reconnect with exponential backoff**, capped at `maxDelayMs`. On reconnect, re-registers all `provide` and `onNotify` subscriptions automatically.
- **Typed error hierarchy** — `BridgeError` (base), `TimeoutError` (code `TIMEOUT`), `ConnectionError` (code `CONNECTION`), `MethodNotAvailableError` (code `METHOD_NOT_AVAILABLE`).
- **Debug logging** — activate with `DEBUG=bridge node …`.
- **MockRouter** in unit tests — deterministic in-process fake router, no real socket needed.

### Repo layout (actual)

```
packages/bridge/
├── src/
│   ├── index.ts                     # public API, re-exports
│   ├── bridge.ts                    # Bridge class
│   ├── transport.ts                 # socket wrapper + reconnect
│   ├── codec.ts                     # msgpack encode/decode + StreamDecoder
│   └── errors.ts                    # BridgeError hierarchy
├── test/
│   ├── bridge.test.ts               # unit tests with MockRouter
│   ├── codec.test.ts                # codec / StreamDecoder unit tests
│   └── integration.test.ts          # real router via SSH tunnel (skipped if UNOQ_SOCKET unset)
├── package.json
├── tsconfig.json
├── vitest.integration.config.ts
├── README.md
└── LICENSE                          # MIT
```

---

## 6. Package 2 — `n8n-nodes-uno-q`

### Shape

- Follows the [n8n community node conventions](https://docs.n8n.io/integrations/creating-nodes/build/). Scaffold from their starter template.
- Depends on `@raasimpact/arduino-uno-q-bridge`.
- **Four nodes in v1:**
  1. **Arduino UNO Q Call** (Action node) — method name, parameters (JSON), timeout. Returns the router's response.
  2. **Arduino UNO Q Trigger** (Trigger node) — method name to register. Fires workflow on every call/notify from the MCU. Two modes:
     - *Notification* — subscribes via `bridge.onNotify`; fire-and-forget (`Bridge.notify()` on MCU). Multiple triggers can share the same method (Bridge-internal handler Set).
     - *Request* — subscribes via `bridge.provide`; handles `Bridge.call()` from MCU. Sub-mode **Response Mode** selects how the MCU gets its answer: *Acknowledge Immediately* returns a user-configurable ack right away and runs the workflow in parallel (v1 default); *Wait for Respond Node* holds the RPC response open until a UNO Q Respond node resolves it, analogous to n8n's Respond to Webhook. Only one trigger can own a Request method.
  3. **Arduino UNO Q Respond** (Action node) — companion to Trigger's *Wait for Respond Node* mode. Reads the `_unoQRequest.msgid` envelope from its input, takes the entry from `PendingRequests`, and resolves (or rejects) the open MessagePack-RPC RESPONSE. See §6.6.
  4. **Arduino UNO Q Method** (action node, `usableAsTool: true`) — exposes one MCU method as an LLM-invokable tool when connected to the [Tools AI Agent](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/tools-agent/)'s Tool port. Users drop one node per method they want the agent to have access to. See §6.4 for the design rationale. Display name intentionally omits "Tool" — n8n's wrapper appends it in the agent's tool list.

  Display names are prefixed with "Arduino UNO Q" so users searching the node picker for either "Arduino" or "UNO Q" find them. The internal `description.name` stays `unoQCall` / `unoQTrigger` / `unoQRespond` / `unoQTool` — that's the ID serialized into workflow JSON and must not change once workflows reference it. `codex.alias` adds further search hits (Arduino, UNO Q, MCU, microcontroller, router, bridge).
- **Socket path** is a node-level parameter with default `/var/run/arduino-router.sock`, exposed under "Advanced options" so users rarely touch it. No n8n Credentials resource in v1 — see §6.5 for the rationale and when to add one.

### Critical design point: singleton client

**Problem:** `$/register` fails if the same method name is registered twice. In n8n, multiple active workflows might try to register `button_pressed` simultaneously. Also, every workflow activation creating a fresh socket connection is wasteful.

**Solution:** a process-singleton [BridgeManager](packages/n8n-nodes/src/BridgeManager.ts) that owns one shared `Bridge` instance and ref-counts the number of subscribers at the bridge level. How it actually works in code:

1. Every trigger calls `manager.acquire(socketPath)` on activate — increments `refCount`, lazily creates the `Bridge` on first use, returns it. The `Call` node uses `manager.getBridge()` which reuses the same instance without touching the refcount (short-lived, doesn't own a subscription).
2. The trigger then calls `bridge.provide(method, handler)` or `bridge.onNotify(method, handler)` directly. **Dedup happens inside the bridge, not inside the manager.** `onNotify` only sends `$/register` for the *first* handler of a method and allows multiple handlers per method (Notification triggers can share). `provide` sends `$/register` every time — the router rejects the second one, which is exactly the "only one trigger can own a Request method" guarantee.
3. On deactivate, the trigger calls `manager.release()` — decrements `refCount`. When it hits zero the manager calls `bridge.close()`, which drops the socket. The router clears all registrations for the disconnected client automatically — no explicit `$/reset` or `$/unregister` call is sent.

The `BridgeManager.methodRefs` map tracks per-method subscriber counts but currently nothing reads the `first`/`last` return values. It's kept for observability and as a hook for future per-method teardown if the Bridge ever grows a `bridge.stopProvide` / `bridge.unregister` method.

**Lifecycle gotcha — deferred responses vs test-mode teardown:** n8n's "Listen for test event" calls the Trigger's `closeFunction` **before** running the downstream workflow with the captured emit. In deferred mode, the provide handler's Promise is still unresolved at that moment. Two bugs possible here, both seen in v1 dev:

1. *Close immediately*: `bridge.close()` tears down the socket, the handler's eventual `transport.write(RESPONSE)` silently returns `false`, MCU hangs on `Bridge.call()`.
2. *Await the drain inside release()*: the workflow can't run the Respond node until `closeFunction` returns — and `closeFunction` is waiting for a handler that can only resolve once Respond runs. **Deadlock** until the Trigger's own 30s timeout rejects the Promise; MCU gets a malformed error response and the Respond node errors with `No pending request for msgid N`.

Fix: the Bridge tracks `activeHandlers` (in-flight provide invocations) and exposes `waitForActiveHandlers(timeoutMs)`; `BridgeManager.release()` **fires-and-forgets** the drain+close — returns synchronously to unblock n8n, lets the handler complete in the background, then closes the socket. The unit test `provide(): waitForActiveHandlers lets a deferred handler send its response before close` pins the drain mechanism in place at the Bridge level; the fire-and-forget rule is enforced by code comment in [BridgeManager.release](packages/n8n-nodes/src/BridgeManager.ts).

**Critical:** this only works if all trigger nodes run in the same Node.js process. n8n's queue mode with separate worker processes would break the assumption — flag this as a known limitation for v1.

### §6.4 Tool node design (for the AI Agent)

The Tool node is what makes this project interesting beyond simple automation: an LLM driving the agent can call MCU functions as tools, reason about the results, and chain multiple hardware operations. Think "check the temperature, and if it's too high, turn on the fan" — expressed in natural language, resolved by the LLM choosing the right tools autonomously.

**The two tool-node patterns in n8n, and which one community packages are allowed to use:**

n8n has two ways a node can appear to an AI Agent as a tool:

1. **`supplyData` + `outputs: [NodeConnectionTypes.AiTool]`** — a pure sub-node with no `execute`. Used by stock `@n8n/nodes-langchain` nodes (ToolCode, McpClientTool, ToolHttpRequest, …).
2. **`usableAsTool: true` on a regular `Main→Main` node with `execute()`** — a dual-purpose node that runs normally in non-AI workflows, and gets auto-wrapped as a LangChain tool when connected to an Agent's Tool port.

**Community (`CUSTOM.`-prefixed) packages can only use pattern 2.** n8n's execution engine silently misroutes `supplyData`-only community nodes onto the main graph, which throws *"has a 'supplyData' method but no 'execute' method"* at runtime. This is confirmed by [n8n PR #26007](https://github.com/n8n-io/n8n/pull/26007) and by inspection of every maintained community tool package on npm ([nerding-io/n8n-nodes-mcp](https://github.com/nerding-io/n8n-nodes-mcp) is the canonical example — it uses pattern 2 exclusively). Requires `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` on the n8n process.

**We picked this up the hard way.** An earlier implementation copied ToolCode/McpClientTool (pattern 1) and worked cleanly at build time but failed at runtime with exactly the error above. The design below uses pattern 2.

**Shape: `usableAsTool: true`, one node = one MCU method.**

UnoQTool is essentially UnoQCall with `usableAsTool: true` and an added `toolDescription` field. It has main I/O; in a classic workflow it behaves like Call. When dropped onto an Agent's Tool port, n8n auto-wraps `execute()` into a DynamicStructuredTool for the LLM.

- **Description** — plain-English, action-oriented, written for the LLM to read. E.g. *"Turns the onboard LED on or off. Pass `true` to turn on, `false` to turn off."* This is the single most important field for tool usability. Bad descriptions = bad LLM decisions.
- **Method** — the MCU method (e.g. `set_led_state`, `read_temperature`). Static per node instance.
- **Parameters** — typed fields or raw JSON array, same UI as UnoQCall. The LLM fills fields whose value contains `$fromAI('name', 'desc', 'type')`; static values pass through unchanged. n8n scans parameter expressions for `$fromAI(...)` calls and builds the tool's input schema from them — no zod, no JSON schema, no langchain dep on our side.
- **Options** — timeout, socket path. Same as Call.

**Why one node = one method and not "configure N methods in one node":**

- **HITL granularity.** n8n's human-in-the-loop is configured *on the agent↔tool connector* in the UI. With per-method nodes, users can gate `set_motor_speed` on approval while leaving `read_temperature` free. This alone is decisive for any workflow touching actuators.
- **Canvas visibility.** Each tool appears as a distinct node with its own name, icon, and connector — reviewers of a workflow see at a glance what the agent can do.
- **Error isolation.** A misconfigured method doesn't take out the others.
- **Matches the idiom.** Every stock community tool node is one-tool-one-node.

**Why not "one generic UnoQ Tool that takes a method name"?** Discrete tools with narrow, well-described purposes are what LLMs handle well. A generic "call any method" tool tempts the LLM into hallucinating method names, misusing it as a shell, and producing opaque errors.

**Why a separate Tool node and not just `usableAsTool: true` on UnoQCall?** Discoverability. A user browsing the AI → Tools category of the node picker should find an "Arduino UNO Q Method" clearly labelled as the AI-agent entry point — not have to know that UnoQCall happens to also work. The ~80 lines of UI duplication are a small price for that affordance.

**Why "Method" and not "Tool" in the display name?** n8n's `usableAsTool` wrapper appends " Tool" to the node's label in the agent's tool list. Calling the node "Arduino UNO Q Tool" would render as "Arduino UNO Q Tool Tool". "Method" is accurate (one MCU method = one node) and composes cleanly to "Arduino UNO Q Method Tool" in the wrapped view.

**Implementation notes:**

- `BridgeManager.getBridge()` is used (not `acquire`/`release`) — the Tool node is short-lived like Call, doesn't own a subscription, and shouldn't participate in the refcount lifecycle.
- No extra peer deps beyond `n8n-workflow`. The langchain/zod wrapping happens inside n8n itself when it auto-wraps the node.
- `execute()` reads parameters via `getNodeParameter` just like Call — `$fromAI()` expressions have already been resolved by the n8n expression evaluator by the time we see the values.

**What about method discovery?** Ideally the user would configure one tool and it auto-populates name/schema from the MCU. For v1: no. The router has no `$/methods` introspection endpoint that I've found, and the MCU's registered methods are declared imperatively at `setup()` with no metadata beyond the name. Configuration is manual per method. This is an open item worth revisiting (see §8) — if Arduino ever adds introspection, we collapse the Methods UI to "pick from dropdown of registered methods." Until then, users type in method name + description + parameters.

**Docstring convention (soft recommendation for MCU sketch style):**

Since descriptions must be typed by the user into n8n, encourage MCU developers to put the intended LLM-facing description as a comment above the `Bridge.provide()` line in their sketch. This way the sketch itself doubles as documentation for anyone setting up the tool node.

```cpp
// Turns the onboard LED on or off. Pass true to turn on, false to turn off.
Bridge.provide("set_led_state", set_led_state);
```

**Capability metadata and retry contract (v2 addition)**

Extends the Method node design with per-method safety metadata for agent-driven hardware scenarios. Motivating problem: when the router socket drops mid-invocation, the MCU may have already executed a write but the RESPONSE never made it back. A naïve retry — by the bridge OR by the LLM reacting to a tool error — fires the actuator twice.

**Two boolean fields per Method node**, defaults both `false` (fail-closed by design):

- **`safeReadOnly`** — "does this method only read state, without changing anything on the MCU?" Advisory signal to the user (HITL config, description prose). The bridge does NOT read this flag.
- **`idempotent`** — "can this method be called multiple times with the same end result?" Passed to `bridge.callWithOptions(..., { idempotent })`. Gates auto-retry on mid-call `ConnectionError`.

**The two flags are orthogonal because all four quadrants are real:**

| | idempotent | not idempotent |
|---|---|---|
| **safe (read-only)** | `read_temperature` — retry freely, no gate | rare consumable reads (e.g. `pop_event`) |
| **unsafe (writes)** | `set_valve(closed)`, `set_led_brightness(50)` — retry is safe because end-state is deterministic, still wants HITL | `pulse_relay`, `move_stepper(+100)` — never retry, must HITL |

The bottom-left quadrant (unsafe + idempotent, the "set X to absolute Y" pattern) is the common IoT case. Collapsing to a single flag would either forbid a safe retry for `set_valve(closed)` or permit an unsafe retry for `pulse_relay`.

**Bridge-level retry contract** (implemented in [packages/bridge/src/bridge.ts](packages/bridge/src/bridge.ts) via `callWithOptions`):

- On `ConnectionError` (mid-call OR when starting a call against a known-disconnected bridge), *and only if* `{idempotent: true}` was passed: `Promise.race` the bridge's `'reconnect'` event against the remaining `timeoutMs` budget. If reconnect wins, retry — and keep retrying through subsequent ConnectionErrors until the call resolves or the budget runs out. A single `arduino-router` restart causes multiple drop/reconnect cycles in practice (the SSH/socket layer reconnects faster than the router fully stabilises), so a single retry leaves residual ConnectionErrors leaking to the caller.
- Each iteration awaits an actual `'reconnect'` event before retrying — no spinning, no fixed sleep. The retry loop terminates the moment the budget is exhausted.
- Never retry on `TimeoutError` — the MCU may still be executing, indistinguishable from success from our vantage point.
- Never retry non-idempotent calls regardless of error type.
- All retries share the original `timeoutMs` budget. The budget is the hard cap on total wall time spent in `callWithOptions`; there is no per-attempt window.
- Calls that *start* during a known-disconnected window also fast-fail with `ConnectionError` rather than writing to a destroyed socket and waiting for the timer (which would deny the retry path a `ConnectionError` to react to). This makes "idempotent calls survive socket disruption" cover *all* disruption, not only mid-call.

**Why LLM-visible safety signaling is left to the user, not auto-composed:**

An earlier design auto-prepended a `[SAFE, IDEMPOTENT]` tag to the tool description. Rejected on three grounds:
1. Different LLMs parse bracket syntax differently; no single format is universal.
2. The convention assumes the LLM understands the tag, which is an empirical question we cannot answer once and for all.
3. It precludes advanced users who want to compose their own prose, JSON-like attributes, or emoji-prefixed styles tuned to their specific model.

Instead:

- `toolDescription` remains a single user-editable field. No hidden composition, no magic preview, no auto-prepending.
- The two booleans are addressable in n8n's expression system as `$parameter.safeReadOnly` / `$parameter.idempotent`, so users who *want* a computed tag can write their own expression — e.g. `={{ "[" + ($parameter.safeReadOnly ? "SAFE" : "UNSAFE") + "] " + "Sets the valve position." }}`.
- The bridge README ships copy-paste templates (bracket-tag, prose, minimal) as guidance, not enforcement.

This separates **bridge-layer safety** (automatic, invisible, driven by `idempotent` only) from **LLM-layer signaling** (fully user-controlled prose in `toolDescription`). A casual user picks two checkboxes and gets correct retry behavior without understanding anything about LLM prompting. An advanced user composes whatever wording their chosen model handles best.

**HITL gate stays orthogonal** — it's configured on the AI Agent node's tool connector, not on the Method node. Coupling it to `safeReadOnly` would block legitimate unsafe-but-autonomous workflows. Docs advise: *"for any Method node with `safeReadOnly: false`, enable HITL on the agent's tool connector."* This is a recommendation, not a mechanism.

**UnoQCall gets the same `idempotent` option** (via the Options collection, default `false`) so both entry points to `callWithOptions` behave consistently. Existing UnoQCall workflows keep their current no-retry behavior by default.

**What was considered and dropped:**

- **`capabilityPreset` dropdown** (Read-only / Absolute write / Relative write / Custom) as progressive-disclosure UX. Dropped for v2 — two checkboxes with direct-question help text are simpler, and users wanting presets can use n8n's node-template feature. Revisit if feedback indicates the checkboxes confuse casual users.
- **Auto-composed description field** with hidden expression logic. Dropped per the reasoning above — explicit user control beats invisible magic.
- **Coupling HITL to `safeReadOnly`**. Dropped — wrong layer, wrong coupling.

**Open items:**

- Router-side `$/methods` introspection (see §8) would let us auto-populate capability metadata from MCU-declared annotations. Not available in current router versions; upstream feature request.
- If a method registry lands, the Method node UI could collapse to "pick a method" + auto-filled capability flags, with manual override for the weird quadrant.

**Implementation phases** (feature branch: `feat/capability-metadata-retry`):

1. **Bridge package.** Add `Bridge.callWithOptions(method, params[], opts)` to [packages/bridge/src/bridge.ts](packages/bridge/src/bridge.ts) implementing the retry contract above. Keep existing `call()` and `callWithTimeout()` as thin backcompat wrappers over it. Add Vitest unit tests in [packages/bridge/test/bridge.test.ts](packages/bridge/test/bridge.test.ts) covering: idempotent retries once on mid-call socket drop, non-idempotent does not retry, no retry on timeout, retry respects the overall `timeoutMs` budget (no second full window). Add a "Retry and idempotency" section to [packages/bridge/README.md](packages/bridge/README.md) with the Venn-quadrant table, the explicit retry contract, and copy-paste expression templates (bracket-tag, prose, minimal) for users composing their own tool descriptions.
2. **n8n-nodes package.** Add `safeReadOnly` and `idempotent` checkboxes (defaults both `false`) to [packages/n8n-nodes/src/nodes/UnoQTool/UnoQTool.node.ts](packages/n8n-nodes/src/nodes/UnoQTool/UnoQTool.node.ts). Help text phrased as direct questions to the user. `toolDescription` field remains untouched — no auto-composition. `execute()` migrates from `bridge.callWithTimeout(...)` to `bridge.callWithOptions(method, params, { timeoutMs, idempotent })`. [packages/n8n-nodes/src/nodes/UnoQCall/UnoQCall.node.ts](packages/n8n-nodes/src/nodes/UnoQCall/UnoQCall.node.ts) gets an `idempotent` Option in its Options collection (default `false`, preserving current behavior) and the same `callWithOptions` migration.
3. **Docs.** Three new rows in [CLAUDE.md](CLAUDE.md) troubleshooting table — one for each observable failure mode: bridge over-retried (flip `idempotent:false`), LLM over-retried (check description tag + enable HITL), bridge under-retried (flip `idempotent:true` for genuinely idempotent methods). Brief pointer in top-level [README](README.md) to the bridge README's "Retry and idempotency" section.
4. **Manual verification on the Q.** Rebuild, `./deploy/sync.sh`, walk through all four Venn quadrants in the agent UI with "Return Intermediate Steps" enabled. Induce a mid-call socket drop (e.g. `sudo systemctl restart arduino-router` during a long-running call) and confirm idempotent auto-retries while non-idempotent surfaces `ConnectionError` cleanly.

### §6.5 Credentials deferred to v2

An earlier draft of this plan included a `UnoQ Credentials` resource as the standard n8n pattern for sharing connection configuration across nodes. Reconsidered: it's premature in v1.

**Why skip it now:**

- The only field a Credentials resource would hold today is a socket path. That path is the same on every UNO Q (`/var/run/arduino-router.sock`) and the container is on the same host as the router — no secrets, no variability that justifies a separate resource.
- n8n Credentials add UX friction (users must create and assign them before any node works). Zero-config out-of-the-box is worth more than future-proofing.
- If a user really needs to override the socket, the per-node "Advanced options" field handles it.

**When to add a Credentials resource (v2 trigger):**

- TCP support lands, and users want to run n8n on a host different from the UNO Q — then host/port/auth become shared state worth centralizing.
- Multi-Q deployments (a workflow that talks to two boards) — Credentials let users pick which Q a node targets.
- Any form of authentication (TLS client certs, tokens) on the router.

Until any of those exists, keep it simple: socket path as a node parameter, no Credentials.

### §6.6 Arduino UNO Q Respond

Companion node to Trigger's *Request / Wait for Respond Node* mode. The Trigger holds the msgpack-rpc RESPONSE open; the Respond node closes it with a workflow-computed value. Same pattern as n8n's [Respond to Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.respondtowebhook/) — just over the router socket instead of HTTP.

**Mechanism (implemented in [UnoQRespond.node.ts](packages/n8n-nodes/src/nodes/UnoQRespond/UnoQRespond.node.ts)):**

- The Trigger's `bridge.provide()` handler returns a `Promise<unknown>` that is stored in the process-wide [PendingRequests](packages/n8n-nodes/src/PendingRequests.ts) singleton, keyed by the router-assigned msgid.
- The Trigger emits the workflow item with a metadata envelope `_unoQRequest: { msgid, socketPath }` alongside the regular `method` / `params` fields.
- The Respond node reads `$json._unoQRequest.msgid` from its input, `take()`s the pending entry, clears its timeout timer, and calls `resolve(value)` (or `reject(message)`). The Bridge then sends the RESPONSE back to the MCU via the normal `provide` code path.
- **Respond With** modes: *First Incoming Item* (sends the input JSON, with the envelope stripped by default), *JSON* (raw JSON expression), *Text* (plain string), *Error* (rejects the call — MCU-side `Bridge.call()` surfaces the message as a failure).
- A node-side timeout (user-configurable on the Trigger, default 30s) rejects the pending entry with a clear error if no Respond node runs in time. This is belt-and-suspenders against the MCU-side `Bridge.call()` timeout and prevents `PendingRequests` from leaking.

**Constraints and caveats:**

- The Trigger and Respond nodes must run in the same Node.js process (the singleton is per-process). Same queue-mode limitation as the rest of the package.
- If the workflow branches past the Respond node without reaching it, or errors before it, the pending entry times out → MCU receives an error response. Document prominently.
- Set the MCU-side `Bridge.call()` timeout higher than the node-side Respond timeout so the failure message comes from our node, not from an MCU-side timeout.
- No changes to the bridge package needed — the plumbing lives entirely in `n8n-nodes-uno-q` (Trigger already writes to `PendingRequests`; Respond just reads from it).

**Why this design**

- Lets the LLM-driven Tools Agent scenario evolve: the MCU could `Bridge.call("ask_llm", question)` and get the agent's answer back, not just an ack.
- Makes classic request/response workflows (MCU asks for a config value, n8n queries a database, MCU acts on the result) possible without polling.
- Keeps the immediate-ack mode available for users who don't need the round-trip — lower latency, simpler workflow.

### Must-haves

- Clear error messages when socket not accessible (missing bind-mount, permissions).
- Trigger nodes must survive bridge reconnection transparently.
- Tool node descriptions must appear verbatim in the LLM's view of available tools (no auto-prefixing with "UnoQ —" or similar — preserve the exact user-written description).
- Documentation with **two** working example workflows (exported JSON): (a) Action + Trigger in a classic automation flow, (b) Tools Agent using at least two UnoQ Method nodes to demonstrate LLM-driven hardware control.

---

## 7. Dev workflow architecture: decisions

> Procedures, commands, testing layers, and triage live in [CLAUDE.md](CLAUDE.md). This section captures only the *decisions* behind them, so they aren't repeatedly re-questioned.

### Monorepo on npm workspaces

Single git repo with `packages/bridge` and `packages/n8n-nodes`, managed by npm workspaces. Settled on npm (not pnpm) because the n8n community nodes tooling is friendlier to plain `npm`. Split into separate repos later if the bridge package gets independent uptake.

### Source of truth lives on PC

App Lab is a **remote editor**: source code lives on the UNO Q, not on the PC. A firmware update **wipes all user apps** — including any App Lab-hosted sketch. → Git on the PC is the source of truth, always. Treat the MCU sketch the same way: commit it to [sketches/](sketches/) even though App Lab can edit it in place.

### Node never runs directly on the UNO Q

Node.js is not installed on the Q outside of containers. All Node-based testing happens either via an SSH-tunneled Unix socket (bridge unit/integration tests from the PC) or inside the n8n container on the Q (n8n-node testing). Never reference `/var/run/arduino-router.sock` as a path in PC-side commands — that path only exists on the Q and inside containers with the socket bind-mounted. Tunnel it and use `/tmp/arduino-router.sock`.

### How n8n sees our packages — Pattern A (dev) and Pattern C (prod)

n8n loads community nodes from `/home/node/.n8n/custom/`. Any npm package in there whose `package.json` declares an `"n8n"` entry point is discovered at startup. We use two patterns:

**Pattern A — bind-mount for dev loop.** [deploy/sync.sh](deploy/sync.sh) builds locally, rsyncs `packages/*/dist` to `custom/packages/*/` on the Q, and restarts n8n with a dev-only compose override that bind-mounts that folder. No image rebuild, no `npm publish`. `sync.sh` wipes `custom/packages` before each sync so stale files from earlier layouts don't get picked up by n8n's recursive `.node.js` scan.

**Pattern C — GUI install from inside n8n (production).** Settings → Community Nodes → Install `n8n-nodes-uno-q`. n8n pulls it from npm with the bridge as a transitive dependency and persists it in the `n8n_data` volume. Updates are one click. This is the shipping story: a user who grabs `deploy/docker-compose.yml` runs `docker compose up -d` and installs the node from the UI. No build on the Q, no cross-arch image rebuild, no bind-mount.

**Why not a custom Docker image (Pattern B)?** Earlier drafts had a Dockerfile that baked `npm install -g n8n-nodes-uno-q` on top of `n8nio/n8n:latest`. Rejected: building that image on a Mac for the UNO Q's arch requires either buildx cross-compilation or building on the Q itself — both fragile, both avoidable once the package is on npm and Pattern C exists.

**Implementation consequence:** because each `*.node.js` ends up a self-contained CJS bundle with its own copy of shared modules (esbuild inlines everything except the n8n-runtime externals), `BridgeManager.getInstance()` must stash the singleton on `globalThis` under a `Symbol.for(...)` key — otherwise each node would see its own `BridgeManager` and the refcount invariant would break. Mechanics in [CLAUDE.md § Dev loop](CLAUDE.md).

---

## 8. Open items and risks

### To verify before significant coding

- [ ] RAM variant of my UNO Q (2 GB vs 4 GB). `free -h` on the board.
- [ ] How does the router handle NOTIFY forwarding when the registrant is temporarily disconnected? Does it queue, drop, or error? Test empirically.
- [ ] How are bytes/buffers serialized through the router for binary data (e.g., I2C reads)? msgpack has a `bin` type; confirm both Python `Bridge` and `Arduino_RouterBridge` round-trip it faithfully.
- [ ] Capitalization of the apps directory on my Q (`arduinoApps` / `ArduinoApps` / `Arduino Apps`). `ls /home/arduino/`.
- [x] npm scope name — **`@raasimpact`** (decided and used throughout).
- [ ] **Method introspection**: does any router version have a `$/methods` or equivalent endpoint that lists currently registered methods with metadata? If yes, Tool node config simplifies dramatically. If not (current state), manual config is fine for v1 but worth raising as a feature request upstream.
- [x] **Arduino UNO Q Respond node** (§6.6): shipped in v1 alongside Trigger's *Wait for Respond Node* sub-mode.
- [x] **Arduino UNO Q Method node** (§6.4): implemented. `usableAsTool: true` Main→Main node with `execute()`; one node = one MCU method; LLM-filled parameters via `$fromAI()`. (Class/dir still named UnoQTool for workflow-JSON stability.)

### Known risks

- **`bridge.py` has undocumented conventions** (types, reconnect timing, error shapes) we'll discover by reverse-engineering behaviour. Read the `.whl` inside `arduino_app_bricks` as reference implementation before finalizing the Node.js API. If it's not published openly yet, ask on the forum for a pointer or extract from the installed wheel.
- **Router version drift**: Q now reports **0.8.0** (updated from 0.5.4 seen in April 2026). Protocol is stable across versions tested so far.
- **Firmware update wipes apps** — mitigated by git-on-PC being the master. But it also wipes the MCU sketch if App Lab is the only source. Treat the sketch as source code too — commit it.
- **Phase 3 (PR upstream) cannot happen while `app-bricks-py` rejects custom bricks distribution.** Per [Arduino staff statement](https://forum.arduino.cc/t/bricks-node-red/1414450), custom bricks must be integrated into the official image. This means phase 3 is gated by Arduino accepting the PR. Phases 1-2 are independent of this and deliver 95% of the value.
- **n8n queue mode incompatibility** (see §6). Document as a v1 limitation.
- **LLM hallucinations on tool calls** — the AI Agent can call tools with wrong parameter types, out-of-range values, or at inappropriate times. Mitigations: strict parameter validation in the Tool node (reject before calling MCU), the optional human-review gate, clear and narrow tool descriptions (so the LLM picks the right one), and sensible defaults on the MCU side (clamp values, refuse unsafe commands). Don't rely on the LLM to "understand" hardware safety.
- **Physical-world side effects** — a workflow automation failure is annoying; an LLM misfiring a relay or overriding a thermostat is dangerous. Default the human-review gate to ON for any tool whose method name suggests a state change on actuators. Users can disable per-tool for trusted read-only methods.

---

## 9. Test log — what's already verified on my Q

All tests run from the PC via SSH tunnel. Node never runs directly on the Q.

```bash
rm -f /tmp/arduino-router.sock && ssh -N -L /tmp/arduino-router.sock:/var/run/arduino-router.sock arduino@linucs.local &
```

### April 2026 — raw socket smoke tests

Before the Bridge package existed, two one-shot scripts in `experiments/` validated the stack:

- `test-router.mjs` — raw msgpack over Unix socket, called `$/version`. Result: `[ 1, 1, null, '0.5.4' ]` ✅
- Manual `set_led_state(true)` call with the LED sketch — LED visibly on. ✅ **End-to-end pipeline validated.**

Router version at that time: **0.5.4**.

### April 2026 — Bridge package integration tests

With [sketches/integration-test.ino](sketches/integration-test.ino) flashed and SSH tunnel open, [packages/bridge/test/integration.test.ts](packages/bridge/test/integration.test.ts) passes all of:

| Test | What it verifies |
|---|---|
| `$/version` returns a non-empty string | Router reachable, protocol working |
| `callWithTimeout` resolves within limit | Timeout path |
| `provide`: Node → router → Node round-trip | Inbound call + response |
| `notify`: Node → router → Node delivery | NOTIFY forwarding |
| `ping` returns `"pong"` | MCU method call |
| `add(2, 3)` returns `5` | Typed params |
| `set_led_state` / `get_led_state` | Write + read state on MCU |
| `set_rgb_state` / `get_rgb_state` | Array-typed params round-trip (`bool[3]`) |
| `heartbeat` NOTIFY arrives within 7s | Async MCU → Node event |
| `gpio_event` via `fire_test_event` | Interrupt flag → MCU `Bridge.call` → Node subscriber |

Router version at time of testing: **0.8.0**.

---

## 10. References

### Arduino

- [arduino/arduino-router](https://github.com/arduino/arduino-router) — the Go router service, with protocol documentation in README.
- [arduino-libraries/Arduino_RPClite](https://github.com/arduino-libraries/Arduino_RPClite) — MCU-side RPC primitives.
- [Arduino_RouterBridge library](https://www.arduinolibraries.info/libraries/arduino_router-bridge) — the higher-level MCU API (`Bridge.provide`, `Bridge.call`).
- [arduino/app-bricks-py](https://github.com/arduino/app-bricks-py) — the official brick repo. Target for phase 3 PR.
- [arduino/arduino-app-lab](https://github.com/arduino/arduino-app-lab) — App Lab desktop source (Wails).

### Protocol

- [MessagePack spec](https://msgpack.org/)
- [MessagePack-RPC spec](https://github.com/msgpack-rpc/msgpack-rpc/blob/master/spec.md)

### Related work / prior art

- [ffich/UNOQ_DoubleBridge](https://github.com/ffich/UNOQ_DoubleBridge) — Node-RED via Python TCP proxy. Useful as negative example of what we're NOT doing.
- Forum thread: [Bricks Node-RED](https://forum.arduino.cc/t/bricks-node-red/1414450) — Arduino staff confirming custom-brick distribution limitation.
- Forum thread: [Node.js Bridge](https://forum.arduino.cc/t/uno-q-has-anyone-tried-using-the-bridge-with-node-js-instead-of-python/1410860) — Arduino staff endorsing our direct-client approach.

### n8n

- [Creating nodes](https://docs.n8n.io/integrations/creating-nodes/build/)
- [Community nodes directory](https://www.npmjs.com/search?q=keywords:n8n-community-node-package)
- [Tools AI Agent node](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/tools-agent/) — the consumer of our Tool nodes.
- [What is a tool? (n8n primer)](https://docs.n8n.io/advanced-ai/examples/understand-tools/)
- [Let AI specify tool parameters ($fromAI)](https://docs.n8n.io/advanced-ai/examples/using-the-fromai-function/)
- [Human-in-the-loop for tool calls](https://docs.n8n.io/advanced-ai/human-in-the-loop-tools/)

---

## 11. Project-level decisions

- **Versioning:** start at `0.1.0`. Semver strict once we hit `1.0.0`.
- **License:** MIT (revisit if Arduino's GPL router imposes anything on a protocol-level client — it shouldn't, but worth a quick legal sanity check before first publish).
- **Update this file** whenever a decision changes. Don't let it go stale. Procedures, commands, and style conventions live in [CLAUDE.md](CLAUDE.md); update them there.