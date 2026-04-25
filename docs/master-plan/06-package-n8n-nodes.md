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

1. Every trigger calls `manager.acquire(socketPath)` on activate — increments `refCount`, lazily creates the `Bridge` on first use, returns it. `acquire()` is exception-safe: if `Bridge.connect` throws, `refCount` is rolled back before the error propagates — without that, a transient connect failure (TLS blip, socket missing) would pin the entry alive forever, which in turn pins the Bridge open, which in turn leaves stale router-side `$/register` claims no way to ever clear. The `Call` node uses `manager.getBridge()` which reuses the same instance without touching the refcount (short-lived, doesn't own a subscription).
2. The trigger then calls `bridge.provide(method, handler)` or `bridge.onNotify(method, handler)` directly. `onNotify` only sends `$/register` for the *first* handler of a method and allows multiple handlers per method (Notification triggers can share). **`provide` is idempotent on the same Bridge instance**: if the method is already present in `providers`, it swaps the handler locally and skips `$/register`. This matters because the socket outlives individual trigger closeFunctions (other triggers may still be holding `refCount`), so the router-side registration persists — a second `$/register` on the same socket would be rejected as `route already exists` and break test-listen re-arm. **The "only one trigger can own a Request method" invariant is now enforced in-process**, by [UnoQTrigger](packages/n8n-nodes/src/nodes/UnoQTrigger/UnoQTrigger.node.ts) checking `BridgeManager.addMethodRef`'s return value: in Request mode, if this isn't the first method-ref subscriber, the trigger refuses with a clear error before ever reaching the bridge.
3. On deactivate, the trigger calls `manager.release()` — decrements `refCount`. When it hits zero the manager calls `bridge.close()`, which drops the socket. The router clears all registrations for the disconnected client automatically — no explicit `$/reset` or `$/unregister` call is sent.

The `BridgeManager.methodRefs` map tracks per-method subscriber counts. The Request-mode single-owner guard reads the `first` return value of `addMethodRef` (see step 2); the `last` return of `removeMethodRef` is currently unused but kept for observability and as a hook for future per-method teardown if the Bridge ever grows a `stopProvide` / `unregister` method.

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
