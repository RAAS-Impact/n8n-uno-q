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

## 3. Verified facts about my UNO Q (hostname: `linucs.local`)

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

**Capability metadata, retry contract, method guards, and rate limiting (v2 addition)**

Extends the Method node design for agent-driven hardware scenarios. Three motivating problems:

1. **Mid-call socket drops.** When `arduino-router` blips, the MCU may have already executed a write but the RESPONSE never made it back. A naïve retry — by the bridge OR by the LLM reacting to a tool error — fires the actuator twice.
2. **Invocations that need per-call vetting.** Even a well-described tool can be invoked with a destructive parameter (`set_motor_speed(9999)`, `delete_record("*")`) or at an inappropriate moment (outside business hours, during a maintenance window). Static per-method "safe/unsafe" metadata cannot distinguish safe from unsafe *invocations*; the decision depends on the actual arguments and on runtime conditions the MCU can't see.
3. **LLM-driven throughput spikes.** An AI Agent can issue tool calls faster than a constrained microcontroller wants to handle — retry loops, exploratory prompting, or an eager model can swamp the MCU, wear actuators, or burn through an external budget. The workflow author doesn't pick the timing (the LLM does), so the cap has to live on the tool node itself, not upstream in the workflow.

**Three runtime mechanisms, one per problem:**

- **`idempotent`** — boolean, per Method node, default `false`. Passed to `bridge.callWithOptions(..., { idempotent })`. Gates auto-retry on `ConnectionError`. Answers: *"if the socket drops, is it safe for the bridge to replay this?"*
- **`methodGuard`** — optional JavaScript function body, per Method node, empty by default. Evaluated at invocation time with `method` (string), `params` (array), and `budget` (see rate-limit contract below) in scope. Typical uses: argument validation, time-of-day gating, external-state checks, traffic-aware rejection. Return `true`/`undefined` to allow, `false` for a generic rejection, a string to reject with that message, or throw. When wired to an AI Agent, the rejection message surfaces as tool output so the LLM can self-correct.
- **`rateLimit`** — optional structured field (`maxCalls` + sliding `window` of `minute`/`hour`/`day`), per Method node, default unset. A sliding-window counter caps invocations that actually reach the MCU. When exceeded, the node short-circuits with a rejection string of the same shape the guard uses, so the LLM can back off.

**Bridge-level retry contract** (implemented in [packages/bridge/src/bridge.ts](packages/bridge/src/bridge.ts) via `callWithOptions`):

- On `ConnectionError` (mid-call OR when starting a call against a known-disconnected bridge), *and only if* `{idempotent: true}` was passed: `Promise.race` the bridge's `'reconnect'` event against the remaining `timeoutMs` budget. If reconnect wins, retry — and keep retrying through subsequent ConnectionErrors until the call resolves or the budget runs out. A single `arduino-router` restart causes multiple drop/reconnect cycles in practice (the SSH/socket layer reconnects faster than the router fully stabilises), so a single retry leaves residual ConnectionErrors leaking to the caller.
- Each iteration awaits an actual `'reconnect'` event before retrying — no spinning, no fixed sleep. The retry loop terminates the moment the budget is exhausted.
- Never retry on `TimeoutError` — the MCU may still be executing, indistinguishable from success from our vantage point.
- Never retry non-idempotent calls regardless of error type.
- All retries share the original `timeoutMs` budget. The budget is the hard cap on total wall time spent in `callWithOptions`; there is no per-attempt window.
- Calls that *start* during a known-disconnected window also fast-fail with `ConnectionError` rather than writing to a destroyed socket and waiting for the timer. This makes "idempotent calls survive socket disruption" cover *all* disruption, not only mid-call.

**Method guard contract** (implemented in [packages/n8n-nodes/src/nodes/UnoQTool/UnoQTool.node.ts](packages/n8n-nodes/src/nodes/UnoQTool/UnoQTool.node.ts) inside `execute()`):

- Guard body is wrapped as `new Function('method', 'params', 'budget', <body>)` — no sandbox, same trust model as the n8n Code node.
- Runs after params are built and coerced, after the rate-limit check, before `bridge.callWithOptions`.
- Return `true` / `undefined` / `null` → allow. Return `false` → reject with a generic message. Return a string → reject with that string. Throw → genuine workflow error, prefixed `Method guard threw:` (reserved for guard bugs — JS syntax errors, unexpected return types).
- Rejections are emitted as a **structured tool output** `{ method, params, refused: true, error: "<message>" }`, not thrown. n8n's `usableAsTool` wrapper does not reliably surface thrown `NodeOperationError`s to the LLM's observation stream (they fall onto the workflow-error bus); returning as data keeps the rejection reachable to the agent so it can self-correct. Non-AI workflows can branch on `json.refused`.
- Empty guard body skips evaluation entirely. Default is empty.
- The UI uses n8n's `jsEditor` widget (`typeOptions.editor: 'jsEditor'`) — syntax-highlighted JavaScript without the `$json`/`$input` autocompletes of `codeNodeEditor`, since those globals aren't provided.

**Rate limit and `budget` contract** (implemented in [packages/n8n-nodes/src/rateLimiter.ts](packages/n8n-nodes/src/rateLimiter.ts) + consumed by [UnoQTool.node.ts](packages/n8n-nodes/src/nodes/UnoQTool/UnoQTool.node.ts)):

- **Gate order per item:** `buildParams → checkRateLimit → methodGuard → recordCall → bridge.callWithOptions`. Rate-limit rejection short-circuits the guard; guard rejection skips `recordCall`, so a rejected call does **not** consume budget that a later legitimate call might need. Recording only happens for calls that reach the MCU.
- **Counter storage.** One map per process, stashed on `globalThis[Symbol.for('@raasimpact/arduino-uno-q/rate-limiter')]` for the same reason `BridgeManager` uses globalThis: each node file is bundled independently by esbuild. Keyed `${node.id}:${method}` — node ids are UUIDs unique across the n8n instance, so multiple UnoQTool nodes don't cross-contaminate and renaming the method on a node cleanly resets its history.
- **Sliding window, lazy cleanup.** Timestamps are filtered by `now - windowMs` on every read; `recordCall` trims to the 24h day-retention cap on every write. No background timer.
- **In-memory only.** Resets on container restart, not shared across queue-mode workers. Already a non-goal (§6.4 singleton client), but the rate-limit feature inherits the same limit and it's documented in the UI copy.
- **`budget` in guard scope** (a read-only view of the counter):
  - `budget.used(window)` → `number` — successful calls recorded in the last `'minute' | 'hour' | 'day'`. Always works, regardless of whether `rateLimit` is configured.
  - `budget.remaining` → `number | null` — `cap - used(configuredWindow)` when `rateLimit` is set, `null` otherwise.
  - `budget.resetsInMs` → `number | null` — ms until the oldest in-window call rolls off when `rateLimit` is set and the window has at least one call, `null` otherwise.
- **Why `budget` is exposed even with no cap.** Lets a guard implement a soft cap ("reject if >20/min") without having to commit to hard enforcement, and lets advanced policies inspect call history cheaply. The common "just cap at N" case still works by filling in the structured field and leaving the guard empty.
- **Rejection message shape.** `Refused: rate limit of ${cap} per ${window} exceeded. Retry in ~${seconds}s.` — mirrors the guard's convention so the LLM only needs one pattern.

**Why a guard replaces the earlier `safeReadOnly` flag:**

- **Enforceable**, not advisory. A boolean saying "this tool is safe" cannot prevent the LLM from passing a dangerous *value* to the tool. A guard inspects the actual parameters and refuses at the gate.
- **Per-invocation**, not per-method. `set_motor_speed(5)` and `set_motor_speed(9999)` are safe and unsafe respectively; a per-method flag can't distinguish.
- **Closes the LLM-retry feedback loop productively.** A rejection message like `"speed must be ≤ 100"` teaches the model what to correct, whereas a generic tool error invites blind retry with the same bad value.

**Why LLM-visible signaling is still left to the user, not auto-composed:**

An earlier design auto-prepended structured tags (`[SAFE, IDEMPOTENT]`) to the tool description. Rejected because different LLMs parse bracket syntax differently; the convention assumes the model understands the tag; and advanced users want to compose their own prose tuned to their specific model. The `toolDescription` field therefore stays a single user-editable string, with `$parameter.idempotent` addressable in expressions for anyone who wants to interpolate that flag into their prose.

**HITL gate stays orthogonal** — configured on the AI Agent's tool connector, not on the Method node. Docs advise enabling HITL on connectors to any Method node whose guard can't fully express the constraint (e.g. because "safety" depends on external state the guard can't see, or because the operation wants a human sign-off regardless of parameter validity).

**UnoQCall gets `idempotent` only** — no `methodGuard`, no `rateLimit`. Non-AI workflows build params themselves and can validate them with standard n8n nodes (IF, Code, Function) *before* the Call node, and pace throughput with SplitInBatches, Wait, or Loop Over Items. The guard and rate-limit fields exist specifically because an AI Agent fills `$fromAI(...)` params at runtime and picks its own timing — there is no workflow-visible node to intercept or throttle.

**What was considered and dropped:**

- **`safeReadOnly` boolean flag.** Replaced by `methodGuard`. A static per-method safety assertion is decorative: the bridge can't read it, HITL wires on the connector not the node, and no LLM convention for bracket-tag parsing is universal. A guard enforces at the gate instead of signalling.
- **`capabilityPreset` dropdown** (Read-only / Absolute write / Relative write / Custom). Dropped — one checkbox plus one optional guard is simpler than a dropdown that explodes into hidden state.
- **Auto-composed description field** with hidden expression logic. Dropped — explicit user control beats invisible magic.
- **Coupling HITL to a node-level flag.** Dropped — wrong layer.
- **Sandboxing the guard** (via `vm2` or similar). Dropped — trusted-user context (anyone who can edit a workflow can write a Code node anyway), and the dependency cost is not justified.
- **n8n-expression mode for the guard** (as an alternative to a JS function body). Dropped — n8n's expression engine doesn't cleanly see resolved tool params, and supporting two modes with different scopes confuses the mental model. One mode, JS function body, full stop.

**Open items:**

- Router-side `$/methods` introspection (see §8) would let us pre-declare per-method parameter schemas, and the guard could default to a schema-derived one. Upstream feature request.

**Status:** shipped. `idempotent` + `callWithOptions` retry landed in bridge 0.2.0; `methodGuard` landed in n8n-nodes 0.2.0; `rateLimit` + `budget`-in-guard landed in n8n-nodes 0.2.1. See the respective [CHANGELOGs](packages/n8n-nodes/CHANGELOG.md) for per-release detail.

### §6.5 Credentials deferred to v2

> **Update (2026-04-21):** superseded by §12. The v2 triggers listed below (TCP support, multi-Q deployments) are now designed in the `feat/multi-q` branch — credentials land as `UnoQRouterApi` alongside the bridge HAL refactor and the Tailscale relay container. Keep this section for historical context; §12.4 is authoritative.

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

---

## 12. Multi-Q support

**Status:** designed on the `feat/multi-q` branch as of 2026-04-21. Not yet implemented. This section is the authoritative spec — start here when picking up the feature.

### 12.1 Motivation

Today a single n8n instance talks to a single UNO Q via the local unix socket, same host. The multi-Q story covers two scenarios:

1. **Remote dev access.** Developer's PC running n8n locally needs to reach a Q across the network. Current workaround is an SSH-tunneled unix socket (§9, CLAUDE.md); fine for occasional tests, clunky for continuous use.
2. **Orchestrator + satellites.** The anticipated Ventuno Q (more powerful than the UNO Q) acts as the n8n orchestrator driving multiple satellite UNO Qs over the LAN. One workflow reads a sensor from Q-A and actuates a motor on Q-B, selected by hostname.

Neither scenario is supported by today's single-socket-same-host design.

### 12.2 Architecture: WireGuard-mesh overlay + relay container

The identity + transport layer is a **WireGuard-based mesh overlay**, with **Tailscale as the default implementation** — a deployment choice, not a lock-in. See §12.2.2 for alternatives we evaluated and their swap-out cost, and §12.5.2's "Swapping the overlay" for the mechanics. The rest of this section describes the default; anywhere the text says "Tailscale" or "`tailscaled`", read that as "the mesh-overlay client of your choice."

Three pieces, landing together:

1. **Bridge HAL refactor** — `Transport` interface in `packages/bridge/` with `UnixSocketTransport` (existing behaviour) and `TcpTransport` (new). Chosen automatically based on config shape. See §12.3.
2. **`UnoQRouterApi` credentials in n8n** — each Q is a named n8n credential (transport + path *or* host+port). Nodes reference it by ID. Credential's Test Connection button runs a `$/version` round-trip. See §12.4.
3. **Relay container** — a plain Docker service the user installs on each satellite Q via docker-compose. Bundles a TCP-to-unix-socket proxy (`socat`) and, in the production variant, `tailscaled` on top. Mounts `/var/run/arduino-router.sock` in, exposes the in-container loopback TCP port, and (with Tailscale) publishes it to the owner's tailnet via `tailscale serve`. See §12.5. **This is not an App Lab "Brick"** in the Arduino sense — it's a manual containerised deployment. See §12.5.3 for notes on possible future Brick packaging.

**Network flow:**

```
[n8n host (PC or Ventuno Q)]                       [UNO Q satellite]
  n8n                                                 arduino-router
    │                                                       ▲
    │ msgpack-rpc over TCP                                  │ unix socket (/var/run/arduino-router.sock)
    ▼                                                       │
  bridge (TcpTransport)                                     │
    │                                                       │
    ▼                                                       │
  tailscale0  ── WireGuard (P2P, end-to-end) ──► tailscale0 │
                                                   │        │
                                                   ▼        │
                                          Relay container   │
                                            ├─ tailscaled   │
                                            └─ socat TCP-LISTEN:<port>,fork
                                               UNIX-CONNECT:/var/run/arduino-router.sock ─┘
```

**Key property:** `arduino-router` itself doesn't change. It keeps its `--unix-port`-only configuration from §3. The relay container is a userspace socket proxy the owner opts into. Uninstalling it returns the Q to today's attack surface exactly.

**Integration with n8n is a no-op.** Tailscale operates at the IP/WireGuard layer, transparent to the application stack. n8n sees a hostname and a port, opens a TCP connection, writes bytes — same primitives it uses for a LAN peer. No n8n plugin for Tailscale, no OAuth flow inside n8n, no custom transport inside n8n-workflow. The only n8n-side change is ours: accepting a host/port in the credential.

### 12.2.1 What was considered and rejected

The following alternatives were evaluated during design and rejected. Don't relitigate without new information.

- **Flip `arduino-router`'s `--listen-port` flag.** Research showed the router has a built-in TCP listener (`-l / --listen-port`) that serves the same RPC surface as the unix socket, through the same `router.Accept(conn)` loop. No TLS, no handshake, no auth — a `grep` for `TLS|Authorization|token|authenticate` across the repo returns zero matches. Enabling it unprotected is equivalent to publishing the MCU's full method set to the LAN. Securing it via interface-binding or firewall rules is fragile, misconfigurable, and exposes the router to misconfiguration bugs. The relay container sidesteps this entirely — router stays on its unix socket.
- **DIY PKI with shared secrets or our own CA.** Rejected as reinventing identity infrastructure. Tailscale already solves enrollment, key rotation, ACLs, and NAT traversal — piggy-backing it is strictly better than writing those correctly ourselves.
- **Arduino Cloud-issued X.509 via `arduino-cloud-cli`.** Would require Arduino to extend manual-device provisioning for a "mesh peer" role *and* add `--tls-cert` / `--tls-client-ca` to arduino-router. No roadmap commitment exists (§12.6). Needs upstream cooperation to be real; blocked.
- **MQTT / NATS broker architecture.** A broker on the orchestrator, satellites publish/subscribe. n8n has mature MQTT nodes, so protocol-wise it would work. Rejected because it reshapes our node design around pub/sub semantics, loses the direct-RPC idiom our nodes are built around today, and adds a broker to operate. Bigger refactor, weaker ergonomics.
- **SSH reverse tunnels in production.** Great for dev (already documented in CLAUDE.md), too fragile for production. Tunnels die, need supervision, bake SSH creds into hosts, don't model per-device ACLs.
- **Python proxy on each Q re-exposing the router.** Same objection as the rejected design in §2. Unnecessary hop, unnecessary second language, unnecessary container.
- **Mock router for multi-Q dev.** Earlier section suggested a local mock; rejected here because the existing SSH-tunneled integration tests already exercise real hardware with essentially the same setup cost. Testing on real HW is winner — a mock would add maintenance without adding realism.
- **Relay as a host-level service (systemd unit or bare binary).** Works but means the user has to install packages directly on the Q. Containerising it keeps the install surface uniform (the user already has `docker compose` in their workflow for n8n itself), makes uninstall clean (`docker compose down && rm -rf ...`), and leaves the Q's base image untouched. Also keeps the door open to eventually packaging as an Arduino App Lab Brick (§12.5.3) without reshaping the deliverable.

### 12.2.2 Overlay implementation — Tailscale default, alternatives in scope

The §12.2 architecture commits to a WireGuard-based mesh overlay as the identity+transport layer. This subsection captures the alternatives we evaluated for that slot, why Tailscale is the default, and what we'd switch to under what conditions.

**Why a WireGuard-based mesh VPN rather than an application-layer zero-trust overlay?** For our case, identity verification happens at **credential-selection time** in the n8n UI ("which Q does this node target?"), not at runtime inside a workflow. Once a user has picked "Kitchen Q" as the credential, the bridge just opens a TCP socket — no per-request identity check is needed. A mesh VPN authenticates at the network layer (no valid peer key → no route), which is exactly enough for this model. Application-layer zero-trust adds value only when each call needs its own identity assertion — which we don't.

**The mesh-VPN family (the actual candidates for the default slot):**

- **Tailscale** — *current default*. Hosted control plane (Tailscale Inc., free personal tier), native multi-OS clients, smallest ops surface. Mature, widely deployed, well-documented enrollment UX. We pay a dependency on Tailscale's coordination server (data stays P2P) and require users to create a Tailscale account.
- **Headscale** — self-hosted, OSS drop-in for Tailscale's coordination server. **Uses the same Tailscale client**; the only relay-side change is pointing `tailscaled` at a custom coordination URL via `TS_LOGIN_SERVER=https://headscale.example.com`. Effort to swap: environment variable. Best choice if the hosted control plane is a blocker but the Tailscale client UX is desired.
- **NetBird** — fully OSS WireGuard-mesh: both client and control plane are open source; self-hosted or their SaaS. Own client (still WireGuard under the hood), setup-key-based enrollment. Effort to swap: replace base image and entrypoint. Bonus: REST API for peer state, which makes "is peer X online and authorised?" queryable from an n8n HTTP Request node if we ever want that visibility inside a workflow.
- **Netmaker** — self-hosted, IoT-oriented. Client can be their `netclient` agent OR a plain WireGuard configuration file. Standard WireGuard configs mean that if Arduino ever ships a WireGuard stack on the MCU or the Q's kernel directly, the MCU / host could join the same mesh natively — no relay container needed. Effort to swap: replace base image and entrypoint.
- **ZeroTier** — virtual L2 network (different model from WireGuard's L3). Own client, mature, self-hostable control plane. Effort to swap: replace base image and entrypoint; n8n-side hostname/IP semantics also differ. Included for completeness; no clear win over Tailscale for our topology.
- **Nebula** — certificate-first, you run lighthouses and manage a CA. Effort to swap: replace the entire overlay stack and commit to a CA management story. Strong audit story but operationally heavy for our scale.

**OpenZiti — considered and deferred, not rejected.** OpenZiti is the strongest contender in the identity-first / zero-trust category: it has an official Node.js SDK (`@openziti/ziti-sdk-nodejs`), CA auto-enrollment for mass provisioning, and "dark service" semantics where services are addressed by name instead of hostname. Deferred for v1 because:

- **Transport mismatch.** The SDK's main ergonomic is `ziti.httpRequest(...)`. Our bridge speaks raw msgpack-rpc over a streaming TCP connection — reachable through OpenZiti's lower-level `dial()` primitives, but we'd be wrapping a native-binary npm module around our existing socket code just to replace the socket.
- **Identity model mismatch.** OpenZiti shines when application code needs per-request identity assertion inline. Our identity verification happens at credential-selection time in the n8n UI, once. Paying for a richer mechanism we don't exercise is cost without benefit.
- **Distribution cost for n8n community nodes.** `@openziti/ziti-sdk-nodejs` ships a native binary downloaded during `npm install`, per OS/architecture. This is operationally painful for an n8n community-nodes package: per-arch prebuilds, install failures on constrained hosts, `NODE_FUNCTION_ALLOW_EXTERNAL` gating on restricted n8n deployments.

**Revisit OpenZiti if** an n8n workflow ever needs to assert "the tool caller is really Q-123 right now" as part of a Method guard or similar runtime check. That is OpenZiti's sweet spot and it would earn its cost there.

**Why Tailscale for v1 specifically:**

1. Zero ops on our side — we don't run a control plane.
2. Native clients mean the n8n-host half is a one-line `brew install` / MSI / apt step for the user, not another container to operate.
3. The relay container's `tailscaled` is the one piece of the stack that's easiest to swap later (§12.5.2), so this is a reversible default.

**Switch triggers:**

- **Fully self-hosted, no external SaaS.** Swap to Headscale (env var change) or NetBird (image swap).
- **MCU-direct mesh membership.** Swap to Netmaker (standard WireGuard configs that MCU stacks might one day speak) or, if we tolerate heavy ops, Nebula.
- **Per-call runtime identity assertion.** Change category — OpenZiti.

None of these is a v1 need. Document the escape hatches (§12.5.2), don't build them speculatively.

### 12.3 Bridge HAL refactor

**Goal:** swap the transport under `Bridge` without touching the RPC state machine, msgid allocation, timeout handling, `callWithOptions` retry logic, `provide` / `onNotify` bookkeeping, or the error hierarchy. All protocol behaviour stays in `bridge.ts`; the network layer becomes pluggable.

**Shape (new files under `packages/bridge/src/transport/`):**

```ts
// transport/transport.ts
export interface Transport {
  connect(): Promise<void>;
  write(bytes: Uint8Array): boolean;
  close(): void;
  on(event: 'data',  listener: (bytes: Uint8Array) => void): this;
  on(event: 'close', listener: (err?: Error) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  // (narrow EventEmitter subset; exact shape TBD during implementation.)
}

// transport/unix-socket.ts
export class UnixSocketTransport implements Transport {
  constructor(opts: { socketPath: string }) { /* existing net.createConnection(path) logic */ }
}

// transport/tcp.ts  (new)
export class TcpTransport implements Transport {
  constructor(opts: { host: string; port: number }) { /* net.createConnection({ host, port }) */ }
}
```

**Bridge construction:**

```ts
// bridge.ts — updated signature
static async connect(opts: {
  // Legacy: preserved for backwards compatibility, equivalent to transport: { kind: 'unix', path: socket }.
  socket?: string;
  // New: explicit transport descriptor.
  transport?:
    | { kind: 'unix'; path: string }
    | { kind: 'tcp'; host: string; port: number };
  reconnect?: ReconnectOptions;
}): Promise<Bridge> { … }
```

**Backwards compatibility:** existing `{ socket: '/var/run/arduino-router.sock' }` callers continue to work unchanged. Internally resolved to `{ transport: { kind: 'unix', path: socket } }`. No behaviour change for the existing unit or integration tests.

**Reconnect semantics are transport's business, not Bridge's.** Both `UnixSocketTransport` and `TcpTransport` handle their own low-level reconnection signals (ECONNRESET, ECONNREFUSED, ETIMEDOUT on TCP; equivalent on unix). The exponential-backoff and subscription-replay logic stays in `Bridge` exactly as today — it listens for `close` and `error` events from whatever transport it holds.

**No change to:** codec, msgid allocation, `callWithOptions`, `provide`, `onNotify`, `MockRouter`, error hierarchy, debug logging. The existing unit suite must pass unchanged after the refactor.

**Integration tests:** add a TCP variant gated on `UNOQ_TCP_HOST` + `UNOQ_TCP_PORT` env vars. Same assertions as the existing unix-socket integration suite (§9); only the transport changes. Development execution path: run the socat-only relay container from §12.7 step 1 on the Q and SSH-forward its TCP port to the PC (`ssh -L 5775:localhost:5775 arduino@linucs.local`) — this gives the bridge a stable TCP target without touching `arduino-router`'s systemd unit and without requiring Tailscale to be set up. The Tailscale layer in step 3 just changes the host the bridge connects to, so once the integration suite is green over SSH-forwarded TCP it stays green over tailnet TCP.

**MockRouter:** its transport input is already abstract-ish. Make it fully transport-agnostic by having unit tests construct a Bridge with a `MockTransport` that directly emits bytes, removing any `net.Socket` assumptions that crept in.

### 12.4 n8n Credentials type — `UnoQRouterApi`

**Why now** (vs. §6.5 deferral): §6.5 explicitly listed "TCP support lands" and "multi-Q deployments" as the v2 triggers. Both land here. Credentials become necessary, not decorative.

**Schema (`packages/n8n-nodes/src/credentials/UnoQRouterApi.credentials.ts`):**

```ts
export class UnoQRouterApi implements ICredentialType {
  name = 'unoQRouterApi';
  displayName = 'Arduino UNO Q Router';
  documentationUrl = 'https://github.com/raasimpact/n8n-uno-q/tree/main/packages/n8n-nodes#credentials';
  properties: INodeProperties[] = [
    {
      displayName: 'Transport', name: 'transport', type: 'options',
      options: [
        { name: 'Unix Socket (local)',                   value: 'unix' },
        { name: 'TCP (remote — relay container, etc.)',  value: 'tcp'  },
      ],
      default: 'unix',
    },
    {
      displayName: 'Socket Path', name: 'socketPath', type: 'string',
      default: '/var/run/arduino-router.sock',
      displayOptions: { show: { transport: ['unix'] } },
    },
    {
      displayName: 'Host', name: 'host', type: 'string',
      placeholder: 'uno-q-kitchen.tailnet-abc.ts.net',
      displayOptions: { show: { transport: ['tcp'] } },
    },
    {
      displayName: 'Port', name: 'port', type: 'number',
      default: 5775,
      displayOptions: { show: { transport: ['tcp'] } },
    },
  ];
  // test = custom generic test — see below.
}
```

**Test Connection:** n8n's credential test infrastructure expects either an HTTP request (not applicable — msgpack-rpc isn't HTTP) or a custom generic `test` function. Use the latter: construct a Bridge with the credential's transport, call `$/version`, close, return the router's version string on success or a friendly error message on failure (socket not found, connection refused, timeout, tailnet peer unreachable). Total round-trip should be sub-second on a healthy network.

**Node changes** (all four: `UnoQCall`, `UnoQTrigger`, `UnoQRespond`, `UnoQTool`):

- Declare `credentials: [{ name: 'unoQRouterApi', required: true }]`.
- Remove the per-node `socketPath` parameter from the Advanced Options tab. For one release cycle, keep reading the old parameter as a fallback if a node has no credential assigned; emit a deprecation warning to the n8n log. Then drop the fallback in the following release.
- Resolve the credential at execute/activate time, pass its transport descriptor into `BridgeManager`.

**BridgeManager keying change** ([packages/n8n-nodes/src/BridgeManager.ts](packages/n8n-nodes/src/BridgeManager.ts)): today keyed by socket path. Update the key to a canonical connection descriptor — `unix:/var/run/arduino-router.sock` or `tcp:uno-q-kitchen.tailnet-abc.ts.net:5775` — so multiple Qs in the same workflow get multiple Bridge singletons, one per credential. The `globalThis[Symbol.for(...)]` escape hatch from §7 still applies — unchanged. All of `BridgeManager`'s refcounting, provide/notify dedup, and lifecycle draining logic from §6.3 continues to work per-credential-key, not globally.

**Rate-limiter key update** ([packages/n8n-nodes/src/rateLimiter.ts](packages/n8n-nodes/src/rateLimiter.ts), see §6.4): current key is `${node.id}:${method}`. With multi-Q, a single node could in principle be re-pointed at a different Q via credential edit; for that (rare) case, extending the key to `${node.id}:${method}:${credentialId}` keeps history clean across re-pointing. Low-priority; decide during implementation whether to ship now or defer.

**Workflow portability:** the credential resource means the same workflow JSON runs on a dev laptop (credential → unix, `/tmp/arduino-router.sock`), on the Q itself (credential → unix, `/var/run/arduino-router.sock`), and against a remote Q (credential → tcp, tailnet hostname) with only the credential's values changing. No workflow edits per environment.

**Multi-Q example:** define two credentials, `Kitchen Q` and `Garage Q`. A workflow that reads a temperature sensor on the kitchen and fires a fan relay on the garage is two Call nodes, one per credential, with no other coordination.

### 12.5 Relay container

**Role:** exposes `arduino-router`'s unix socket as a TCP endpoint, optionally wrapped in a Tailscale overlay. Runs on each satellite Q. Installed by the user via `docker compose`, same muscle memory as the n8n container. If not installed, the Q stays exactly as it is today — router reachable only via the local unix socket.

**Lives under [deploy/relay/](deploy/relay/)** (to be created) alongside the existing `deploy/docker-compose.yml`.

**Two variants, developed sequentially** (§12.7):

- **Variant A — socat-only.** Minimal image: `alpine` + `socat`. Exposes the router's unix socket as a TCP listener bound to an arbitrary interface (loopback, LAN, or anything). No auth, no identity, nothing but byte-pumping. **Useful on its own** for a trusted-LAN setup and as the target the bridge HAL + credentials (§12.7 step 2) are developed against.
- **Variant B — socat + Tailscale.** Adds `tailscaled` on top, so the TCP endpoint is reachable only from devices in the owner's tailnet. This is the production shape for untrusted networks. Everything except the enrollment UX and the network-layer transport is identical to Variant A.

#### 12.5.1 Variant A — socat-only (step 1 deliverable)

**Dockerfile (conceptual):**

```dockerfile
FROM alpine:3                                # minimal, already has docker first-party support on ARM64
RUN apk add --no-cache socat
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

**Entrypoint** — a one-liner, essentially:

```sh
#!/bin/sh
exec socat TCP-LISTEN:${INTERNAL_PORT:-5775},reuseaddr,fork UNIX-CONNECT:/var/run/arduino-router.sock
```

The `fork` option on socat gives one child process per incoming TCP connection, each mapping 1:1 to a fresh unix-socket connection to `arduino-router`. The router already supports multiple concurrent clients on its unix socket (§3), so no serialisation is required. socat itself is PID 1 — if it dies, the container exits and the restart policy takes over.

**docker-compose fragment (conceptual):**

```yaml
unoq-relay:
  image: ghcr.io/raasimpact/unoq-relay:latest        # built from deploy/relay/
  restart: unless-stopped
  ports:
    - "127.0.0.1:5775:5775"                          # bind to loopback by default; override for LAN
  volumes:
    - /var/run/arduino-router.sock:/var/run/arduino-router.sock:rw
  # environment:
  #   INTERNAL_PORT: 5775                            # default
```

**Intended test rig for steps 1–2:**

1. User deploys the socat-only container alongside the existing n8n container on the Q (same `docker compose up -d`).
2. From the PC, `ssh -L 5775:localhost:5775 arduino@linucs.local` forwards the Q's loopback port to the PC's loopback — same idiom as the existing unix-socket tunnel, just over TCP.
3. `UNOQ_TCP_HOST=127.0.0.1 UNOQ_TCP_PORT=5775 npm run test:integration -w packages/bridge` exercises the TCP transport end-to-end against the real Q.
4. Local n8n (dev) can target the same loopback with a `UnoQRouterApi` credential (transport=tcp, host=127.0.0.1, port=5775).

This is the whole dev loop for the bridge HAL + credentials work. No Tailscale involved yet.

#### 12.5.2 Variant B — socat + Tailscale (step 3 deliverable)

**Dockerfile (conceptual):** build on Variant A's entrypoint, swap the base image for Tailscale's, add the tailscaled bootstrap.

```dockerfile
FROM tailscale/tailscale:latest              # official, Alpine-based, maintained upstream
RUN apk add --no-cache socat
COPY entrypoint.sh /entrypoint.sh            # extended version — see below
RUN chmod +x /entrypoint.sh
ENV TS_STATE_DIR=/var/lib/tailscale
VOLUME ["/var/lib/tailscale"]
ENTRYPOINT ["/entrypoint.sh"]
```

**Entrypoint responsibilities (in order):**

1. Start `tailscaled` as a background process, wait for its local API socket to come up.
2. If not already authenticated (state dir empty), run `tailscale up --authkey=${TS_AUTHKEY} --hostname=${TS_HOSTNAME}` to join the tailnet.
3. Configure `tailscale serve --bg --tcp ${TS_PORT:-5775} tcp://127.0.0.1:${INTERNAL_PORT:-5775}` so the tailnet-facing port forwards into the container's loopback.
4. `exec socat TCP-LISTEN:${INTERNAL_PORT:-5775},reuseaddr,fork UNIX-CONNECT:/var/run/arduino-router.sock` — the same PID 1 as Variant A.

**docker-compose fragment (conceptual):**

```yaml
unoq-relay:
  image: ghcr.io/raasimpact/unoq-relay-tailscale:latest   # built from deploy/relay/ with a -tailscale build target
  restart: unless-stopped
  network_mode: host                                       # simplest path to WireGuard tun + loopback
  cap_add:
    - NET_ADMIN
    - NET_RAW
  devices:
    - /dev/net/tun
  volumes:
    - /var/run/arduino-router.sock:/var/run/arduino-router.sock:rw
    - tailscale-state:/var/lib/tailscale
  environment:
    TS_AUTHKEY: ${TS_AUTHKEY:?set in .env or pass at run time}
    TS_HOSTNAME: ${TS_HOSTNAME:-uno-q}                     # appears in Tailscale admin + as DNS name in the tailnet
    # TS_PORT / INTERNAL_PORT default to 5775.
volumes:
  tailscale-state:                                          # persists device identity — auth key reused only on first boot
```

**Why `network_mode: host`:** simplest path to (a) give Tailscale's WireGuard driver access to `/dev/net/tun` and userspace routing, and (b) let `socat` still be reachable via loopback for `tailscale serve`. Userspace-networking mode (`TS_USERSPACE=1`) is a fallback if the Q's Docker rejects `NET_ADMIN` or `/dev/net/tun` — worth validating empirically during implementation (§12.8).

**Enrollment UX:**

1. User creates a reusable or (preferred) single-use auth key in the Tailscale admin console, tagged `tag:unoq` so tailnet ACLs can target satellites specifically.
2. User pastes it into the relay container's `.env` file (`TS_AUTHKEY=tskey-auth-...`).
3. `docker compose up -d` boots the relay; `tailscaled` joins the tailnet, advertises the Q at `${TS_HOSTNAME}.${tailnet}.ts.net`.
4. User defines a `UnoQRouterApi` credential in n8n with transport=tcp, host=that hostname, port=5775.
5. Any node referencing that credential can now call MCU methods on that Q.

**Host-side prerequisites on the n8n machine** (not the Q):

- Tailscale installed and enrolled in the same tailnet. Native Tailscale app on macOS / Windows / Linux for dev; the same relay container image (or a standalone `tailscaled`) on the Ventuno Q orchestrator in prod.
- No n8n configuration changes needed. No plugin, no n8n-side Tailscale integration — the tailnet is transparent at the network layer.

**Swapping the overlay.** The Tailscale-specific half of the container is isolated to the base image and the entrypoint's enrollment + serve logic. The socat half, the bind-mount, `/var/run/arduino-router.sock`, our bridge, and the n8n credential schema are all overlay-agnostic. Concretely, to swap Tailscale for another WireGuard-mesh overlay (see §12.2.2 for the candidates):

- **Headscale** — *smallest possible change*. Keep `FROM tailscale/tailscale` and `tailscaled` exactly as-is. Set `TS_LOGIN_SERVER=https://headscale.example.com` in the compose `environment:` block and issue auth keys from your Headscale instance instead of the Tailscale admin console. No image rebuild.
- **NetBird** — swap `FROM tailscale/tailscale` for `FROM netbirdio/netbird` (or equivalent), replace the `tailscale up` + `tailscale serve` calls in the entrypoint with NetBird's `netbird up --setup-key=...` + whatever exposes the container port to the overlay. The socat invocation at the end stays identical. Expected diff: ~20-30 lines in the Dockerfile + entrypoint.
- **Netmaker / ZeroTier / Nebula** — same shape as NetBird (new base image, new enrollment in the entrypoint), with more ceremony around CA / cert management for Nebula.

Nothing on the n8n side changes for any of these swaps — the credential still points at a hostname:port. The hostname format changes (`*.ts.net` → whatever the chosen overlay uses), which is a value in the credential, not a code change.

We don't ship Variant B images for these alternatives in v1. Document the swap path for users who need it; build additional variants only if demand appears.

#### 12.5.3 Future App Lab Brick packaging

We know from §12.6 that Arduino's "Bricks" are mechanically Docker containers orchestrated by `arduino-app-cli`, but that third-party Bricks are not a supported category today — the Brick channel is Arduino-curated and there's no public spec, registry, or signing requirement. The relay container above is therefore **not** a Brick; it's a plain docker-compose service the user installs manually.

If Arduino later opens the Brick channel to third-party contributions, this container is a natural candidate: it already matches the shape (image bundles everything, bind-mounts the router socket, long-running service). What would likely change:

- **Installation UX** — from `docker compose up -d` + editing `.env` to an App Lab config form that takes `TS_AUTHKEY` and `TS_HOSTNAME` and materialises the compose entry into `arduino-app-cli`'s generated compose file.
- **Image hosting** — possibly `ghcr.io/arduino/app-bricks/...` instead of our own GHCR org, depending on Arduino's policy.
- **Default port / network-mode choices** — might need to conform to whatever conventions App Lab establishes.

What would *not* change: the container contents (socat + tailscaled), the bridge and n8n side of the stack, or the security model. The relay stays the same relay; only the way a user acquires and configures it differs. So the effort is not wasted if Bricks never open up — and it's cleanly re-packageable if they do.

### 12.5.4 Security model

**Threat model:** the satellite Q sits on an untrusted or semi-trusted LAN. Possible attackers include other devices on the LAN, the user's ISP, public WiFi co-tenants, and (hypothetically) anyone who compromises a device legitimately on the user's tailnet.

**Defenses:**

- **Router attack surface is unchanged.** `arduino-router` still listens only on `/var/run/arduino-router.sock`. Nothing on the LAN can reach it. The relay container's `socat` listens inside the container's view of loopback (or host loopback under `network_mode: host`); either way, not reachable from any non-tailnet network path.
- **Tailnet access is key-gated.** Every WireGuard packet is authenticated by the peer's public key. No valid key → no route → no connection attempt reaches the listener. Brute-forcing this is computationally infeasible.
- **Per-device ACLs.** The Tailscale admin lets the owner constrain "only my laptop and my orchestrator Q may reach satellites tagged `tag:unoq`". A compromised unrelated tailnet device cannot touch the router.
- **Transit encryption.** WireGuard, end-to-end. Tailscale's coordination server brokers initial key exchange but never sees data. DERP relays, when used as a P2P fallback, are end-to-end encrypted and opaque to Tailscale.

**Out of scope for this layer:**

- A compromised n8n host already legitimately on the tailnet. It can call any MCU method the router exposes. Mitigate at the Method node layer (guards, rate limits, HITL) — the existing §6.4 primitives stay the right answer for this.
- A leaked Tailscale auth key exploited before first enrollment. Tailscale recommends single-use + short-TTL keys; the relay container's docs should say the same.
- Physical access to the satellite Q. No network-layer solution addresses this.

**What the model explicitly is *not*:** application-layer auth on top of msgpack-rpc. Authentication lives at the network layer, consistent with Tailscale's documented deployment patterns (internal DBs, SSH, dashboards are all commonly exposed behind tailnet membership alone). If a deployment's threat model requires defense-in-depth at the application layer, a pre-shared-key or token check can be added as a v2.1 feature — not required for v1.

### 12.6 Verified findings about the Arduino ecosystem

Captured here so they don't have to be re-researched. All verified against `arduino/arduino-router` source on `main` as of 2026-04-21, the `linucs.local` UNO Q, and public Arduino documentation.

- **`arduino-router` has a TCP listener, but it's off by default.** The `-l / --listen-port` flag wires up a `net.Listen("tcp", addr)` whose accepted connections feed the same `router.Accept(conn)` loop as the unix-socket listener — identical help string ("Listening port for RPC services"), identical method surface (`networkapi`, `hciapi`, `$/serial/*`, `$/version`), no transport-conditional logic anywhere. A TCP client gets the full RPC surface, including `$/serial/open` into the MCU. The shipped systemd unit on the UNO Q uses only `--unix-port` and `--serial-port`. No TLS, no handshake, no auth: `grep` across the repo for `TLS|Authorization|token|authenticate` returns zero matches. The router's trust model is "root on this box owns the socket"; that does not extend over TCP.
- **No secure element on the UNO Q.** MCU is STM32U585 (on-die HUK/PKA/SAES/TRNG, but Arduino does not visibly use them for device identity). MPU is Qualcomm QRB2210 (TrustZone exists in silicon, but no OP-TEE supplicant, no `/dev/tee*`, no `/dev/tpm*`, no `/dev/qseecom*` exposed to Linux). No ATECC608 on any I²C bus. `/etc/arduino*` and `/var/lib/arduino*` contain no factory-provisioned certificate or key.
- **UNO Q registers as a "manual device" in Arduino Cloud.** It receives a `device_id` + `secret_key` pair, not an X.509 certificate — contrast with MKR / Opta / Portenta, which carry factory-provisioned client certs in an ATECC608. The UNO Q's own persistent hardware identity, visible to userspace, is the Qualcomm qfprom serial under `/sys/devices/soc0/serial_number`.
- **"Bricks" are Docker containers orchestrated by `arduino-app-cli`.** No published manifest format, no signing requirement, no registry, no third-party brick channel. `arduino-app-cli daemon` on the Q exposes an unauthenticated localhost REST API for app/brick management. A "brick" shipped by us is, mechanically, a docker-compose service the user opts into.
- **mDNS identity on the LAN.** The Q advertises `_arduino._tcp` on port 80 with a TXT record containing `serial_number=<qfprom>`, `vid=0x2341`, `pid=0x0078`, `auth_upload=yes`. The "auth" is `arduino-create-agent`'s signed-command pattern (Arduino's public key embedded in config; no TLS). Usable as an identifier, not as an authenticator.
- **All Arduino auth precedents are device → cloud outbound mTLS** (MKR/Opta/Portenta via ATECC608 + Arduino Cloud CA; Portenta X8 via Foundries.io). None of them authenticate a peer → device LAN connection. Our use case has no direct precedent inside the Arduino ecosystem — one reason we chose an external network-layer overlay rather than inventing new device-side identity primitives.

**Implication for design:** Arduino has no ready-to-use identity primitive we can piggy-back on for mutual device-to-device authentication. Any such primitive we build would be ours alone. Choosing Tailscale pushes the identity problem onto infrastructure designed for exactly this, rather than inventing a small-footprint version of it.

### 12.7 Implementation order

Target sequence for landing on `feat/multi-q`. Each step should be independently reviewable and leave the tree green. The order is deliberately **socat container first → bridge + n8n against it → Tailscale layered on top**, because it isolates each concern:

- Step 1 validates the socket-proxy approach in isolation, before any bridge changes exist.
- Step 2 develops the bridge HAL + credentials against a stable TCP target on a trusted LAN — no networking overlay in the picture.
- Step 3 adds Tailscale last, and only changes the hostname the credential points at. If the bridge works over LAN TCP (step 2), Tailscale is a pure overlay that can't break the RPC layer.

Each step is also shippable on its own — a release containing only steps 1–3 is already useful to anyone operating a trusted LAN and doesn't force Tailscale onto them.

1. **Variant A relay container — socat only** (§12.5.1). Build the minimal image under [deploy/relay/](deploy/relay/), `docker compose up -d` alongside the existing n8n container on the Q. Test by hand: SSH-forward the TCP port to the PC, run a one-shot msgpack-rpc script against it (e.g. an adapted [experiments/test-router.mjs](experiments/test-router.mjs) pointed at TCP) and confirm `$/version` round-trips. **Deliverable:** a published image (`ghcr.io/raasimpact/unoq-relay`) and a compose fragment. Usable on its own by anyone with a trusted LAN.
2. **Bridge HAL refactor** (§12.3). Extract `Transport` interface, migrate unix-socket logic into `UnixSocketTransport`, add `TcpTransport`. Preserve existing `Bridge.connect({ socket })` shape via an internal adapter. Unit tests green on both transports using a transport-agnostic `MockTransport`. TCP integration tests gated on `UNOQ_TCP_HOST` / `UNOQ_TCP_PORT`, pointed at step 1's relay container via the SSH-forward.
3. **`UnoQRouterApi` credentials + node wiring** (§12.4). Credential class with `test` function, node `credentials:` declaration on all four nodes, `BridgeManager` keying change, rate-limiter key update. Backwards-compat shim for inline `socketPath` with a deprecation warning. Validate end-to-end by running n8n on the PC with a credential pointing at step 1's container (transport=tcp, host=127.0.0.1 via SSH-forward) and exercising every node type — Call, Trigger (both modes), Respond, Method.
4. **Variant B relay container — add Tailscale** (§12.5.2). Extend the step-1 image to `FROM tailscale/tailscale`, wire `tailscaled` + `tailscale serve` into the entrypoint, add the production compose fragment with `NET_ADMIN` / `/dev/net/tun` / state volume. Smoke-test: enrol one Q in a tailnet, change the n8n credential's host from loopback to `uno-q.tailnet-abc.ts.net`, confirm the same workflow keeps working end-to-end. **The transport from n8n's perspective does not change** — it's still a TCP connection to a hostname. Everything validated in step 3 continues to work; only the route the packets take differs.
5. **Docs + examples**. Top-level README "Multi-Q setup" section covering both variants (trusted-LAN with Variant A, untrusted networks with Variant B), update to [CLAUDE.md § Dev loop / Troubleshooting](CLAUDE.md) for the relay container's role and new failure modes (container stopped, tailnet disconnected, auth key expired), example workflow under `examples/multi-q/` referencing two credentials.

### 12.8 Open items

- **Arduino's roadmap for `--listen-port` auth.** File a question on `arduino/arduino-router` asking whether the TCP listener is a supported production interface and whether TLS / client-cert auth is on the roadmap. If yes, there may eventually be a simpler v2.1 path that drops the relay container in favour of the router's native TLS — unlikely near-term, worth on record. Draft of the question lives in the `feat/multi-q` thread history.
- **Relay container on the Q's actual Docker runtime.** Validate empirically that `network_mode: host` + `cap_add: [NET_ADMIN, NET_RAW]` + `/dev/net/tun` are accepted for Variant B. If not, fall back to `TS_USERSPACE=1` (userspace WireGuard, slower but fewer host requirements). Variant A has no such requirements and should run on any Docker.
- **Ventuno Q availability.** If/when the Ventuno Q ships, re-verify the relay container runs on its hardware (same Docker stack expected) and that the orchestrator side works too (likely runs a native `tailscaled` on the host rather than the relay container, but worth confirming; the orchestrator doesn't need the socat half because its own arduino-router is local).
- **Multiple-Q authoring UX.** Once credentials land, check the node-picker and credential dropdown don't feel clunky with 5+ credentials defined. Possibly worth interpolating credential name into node display when a credential is bound, so canvas reads "Kitchen Q · Call" rather than just "Call".
- **Queue-mode incompatibility still stands.** Multi-Q does nothing to fix it (§6 singleton-client note remains). Flag in docs; both the singleton and the rate limiter remain per-process.
- **Auth key rotation UX.** What happens when a Tailscale auth key expires and the relay container restarts? The state volume persists the node identity, so normal restarts don't re-auth. A full device-key rotation flow is a Tailscale admin action and out of scope — but the relay container's docs should point at it.

### 12.9 Related sections

- §2 — Architecture decision (direct to router, no Python proxy). Multi-Q keeps this invariant: no extra language, no extra process on the Q other than the relay container (which is a userspace socket proxy, not an RPC translator).
- §5 — Bridge package API. §12.3 is a refactor *under* this API; the public shape gains a `transport:` option but stays backwards-compatible.
- §6.3 — BridgeManager singleton and refcount. §12.4's keying change (socket path → canonical connection descriptor) is a local change inside BridgeManager, not a contract change.
- §6.4 — Method node guards and rate limits. These remain the application-layer defense for compromised tailnet peers (§12.5.1).
- §6.5 — "Credentials deferred to v2". Superseded here; see cross-reference at the top of that section.
- §8 — Open items. Multi-Q-specific opens live here in §12.8; §8 stays focused on v1 hardware verification items.