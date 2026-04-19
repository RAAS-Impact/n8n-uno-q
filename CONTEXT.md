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
- **Three nodes in v1:**
  1. **Arduino UNO Q Call** (Action node) — method name, parameters (JSON), timeout. Returns the router's response.
  2. **Arduino UNO Q Trigger** (Trigger node) — method name to register. Fires workflow on every call/notify from the MCU. Two modes:
     - *Notification* — subscribes via `bridge.onNotify`; fire-and-forget (`Bridge.notify()` on MCU). Multiple triggers can share the same method (Bridge-internal handler Set).
     - *Request* — subscribes via `bridge.provide`; handles `Bridge.call()` from MCU. Sub-mode **Response Mode** selects how the MCU gets its answer: *Acknowledge Immediately* returns a user-configurable ack right away and runs the workflow in parallel (v1 default); *Wait for Respond Node* holds the RPC response open until a UNO Q Respond node resolves it, analogous to n8n's Respond to Webhook. Only one trigger can own a Request method.
     - The Trigger is already wired for both ack modes in v1 — the Respond node ships in v2 (§6.6). Until then, *Wait for Respond Node* will time out because nothing resolves the pending entry.
  3. **Arduino UNO Q Tool** (Tool sub-node for the [Tools AI Agent](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/tools-agent/)) — exposes an MCU method as an LLM-invokable tool. **Scaffold only in v1** — the node registers with n8n so the package loads, but `supplyData` throws "not yet implemented". Real implementation is planned for v2 alongside the Respond node. See §6.4 for the intended design.

  Display names are prefixed with "Arduino UNO Q" so users searching the node picker for either "Arduino" or "UNO Q" find them. The internal `description.name` stays `unoQCall` / `unoQTrigger` / `unoQTool` — that's the ID serialized into workflow JSON and must not change once workflows reference it. `codex.alias` adds further search hits (Arduino, UNO Q, MCU, microcontroller, router, bridge).
- **Socket path** is a node-level parameter with default `/var/run/arduino-router.sock`, exposed under "Advanced options" so users rarely touch it. No n8n Credentials resource in v1 — see §6.5 for the rationale and when to add one.

### Critical design point: singleton client

**Problem:** `$/register` fails if the same method name is registered twice. In n8n, multiple active workflows might try to register `button_pressed` simultaneously. Also, every workflow activation creating a fresh socket connection is wasteful.

**Solution:** a process-singleton [BridgeManager](packages/n8n-nodes/src/BridgeManager.ts) that owns one shared `Bridge` instance and ref-counts the number of subscribers at the bridge level. How it actually works in code:

1. Every trigger calls `manager.acquire(socketPath)` on activate — increments `refCount`, lazily creates the `Bridge` on first use, returns it. The `Call` node uses `manager.getBridge()` which reuses the same instance without touching the refcount (short-lived, doesn't own a subscription).
2. The trigger then calls `bridge.provide(method, handler)` or `bridge.onNotify(method, handler)` directly. **Dedup happens inside the bridge, not inside the manager.** `onNotify` only sends `$/register` for the *first* handler of a method and allows multiple handlers per method (Notification triggers can share). `provide` sends `$/register` every time — the router rejects the second one, which is exactly the "only one trigger can own a Request method" guarantee.
3. On deactivate, the trigger calls `manager.release()` — decrements `refCount`. When it hits zero the manager calls `bridge.close()`, which drops the socket. The router clears all registrations for the disconnected client automatically — no explicit `$/reset` or `$/unregister` call is sent.

The `BridgeManager.methodRefs` map tracks per-method subscriber counts but currently nothing reads the `first`/`last` return values. It's kept for observability and as a hook for future per-method teardown if the Bridge ever grows a `bridge.stopProvide` / `bridge.unregister` method.

**Critical:** this only works if all trigger nodes run in the same Node.js process. n8n's queue mode with separate worker processes would break the assumption — flag this as a known limitation for v1.

### §6.4 Tool node design (for the AI Agent) — planned v2

> **Status:** the current [UnoQTool.node.ts](packages/n8n-nodes/src/nodes/UnoQTool/UnoQTool.node.ts) is a scaffold that registers with n8n so the package loads cleanly; `supplyData` throws "not yet implemented". Everything below is the intended v2 design, not what ships in v1.

The Tool node is what makes this project interesting beyond simple automation: an LLM driving the agent can call MCU functions as tools, reason about the results, and chain multiple hardware operations. Think "check the temperature, and if it's too high, turn on the fan" — expressed in natural language, resolved by the LLM choosing the right tools autonomously.

**How n8n tool nodes work** (short primer so decisions below make sense):

- A tool is a sub-node connected to a Tools Agent root node via the `ai_tool` connection type.
- Each tool exposes to the LLM: a **name**, a **natural-language description** of what it does, and a **parameter schema** (JSON Schema-ish) describing inputs.
- At runtime, the LLM decides which tool to call and with which parameters. n8n supports the `$fromAI()` expression so tool parameters can be filled dynamically by the LLM — see [Dynamic parameters for tools with $fromAI()](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/tools-agent/#dynamic-parameters-for-tools-with-fromai).
- The tool node executes, returns a result, and the LLM continues reasoning with it in context.

**Key design choice: one tool = one MCU method (not one generic tool).**

We could build a single "UnoQ Tool" that takes method name as a parameter and lets the LLM pick whatever. **Don't.** Discrete tools with narrow, well-described purposes are what LLMs handle well. A generic "call any method" tool tempts the LLM into hallucinating method names, misusing it as a shell, and producing opaque errors. Instead, the user adds one UnoQ Tool node per method they want the LLM to have access to — each with:

- **Name** — the MCU method (e.g. `set_led_state`, `read_temperature`).
- **Description** — plain-English, action-oriented, written for the LLM to read. E.g. *"Turns the onboard LED on or off. Pass `true` to turn on, `false` to turn off."* This is the single most important field for tool usability. Bad descriptions = bad LLM decisions.
- **Parameter schema** — list of parameters with name, type, description, and whether required. Used both for n8n UI validation and for what the LLM sees when deciding how to call.
- **Safety gate (optional but recommended default)** — a checkbox "Require human review for this tool call" that surfaces the call for confirmation before execution. For anything physical (motors, heaters, high-voltage), default this to on. See n8n's [Human review for tool calls](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/tools-agent/#human-review-for-tool-calls).

**Implementation detail:** the Tool node extends the same underlying client as the Call node — under the hood it's still `bridge.call(method, params)`. The novelty is the n8n class hierarchy (tool sub-node with `ai_tool` output) and the per-tool metadata (description, schema) used by the LLM.

**What about method discovery?** Ideally the user would configure one tool and it auto-populates name/schema from the MCU. For v1: no. The router has no `$/methods` introspection endpoint that I've found, and the MCU's registered methods are declared imperatively at `setup()` with no metadata beyond the name. Configuration is manual per tool. This is an open item worth revisiting (see §8) — if Arduino ever adds introspection, we collapse the Tool node config to "pick from dropdown of registered methods." Until then, users type in method name + description + schema.

**Docstring convention (soft recommendation for MCU sketch style):**

Since descriptions must be typed by the user into n8n, encourage MCU developers to put the intended LLM-facing description as a comment above the `Bridge.provide()` line in their sketch. This way the sketch itself doubles as documentation for anyone setting up the tool node.

```cpp
// Turns the onboard LED on or off. Pass true to turn on, false to turn off.
Bridge.provide("set_led_state", set_led_state);
```

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

### §6.6 Arduino UNO Q Respond (planned v2)

Companion node to Trigger's *Request / Wait for Respond Node* mode. The Trigger holds the msgpack-rpc RESPONSE open; the Respond node closes it with a workflow-computed value. Same pattern as n8n's [Respond to Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.respondtowebhook/) — just over the router socket instead of HTTP.

**Mechanism:**

- The Trigger's `bridge.provide()` handler returns a `Promise<unknown>` that is stored in a process-wide **`PendingRequests`** singleton, keyed by the router-assigned msgid.
- The Trigger emits the workflow item with a metadata envelope `_unoQRequest: { msgid, socketPath }` alongside the regular `method` / `params` fields.
- The Respond node reads `$json._unoQRequest.msgid` from its input, looks up the pending entry, and calls `resolve(value)` (or `reject(message)`). The Bridge then sends the RESPONSE back to the MCU via the normal `provide` code path.
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
- Documentation with **two** working example workflows (exported JSON): (a) Action + Trigger in a classic automation flow, (b) Tools Agent using at least two UnoQ Tools to demonstrate LLM-driven hardware control.

---

## 7. Dev workflow: master on PC, deploy on UNO Q

Decision: **source of truth lives on PC**, git repo local, sync to UNO Q for testing.

### Project layout on PC

```
~/projects/n8n-uno-q/                   # single git repo (monorepo), or two repos — TBD
├── CONTEXT.md                          # this file
├── packages/
│   ├── bridge/                         # @raasimpact/arduino-uno-q-bridge
│   └── n8n-nodes/                      # n8n-nodes-uno-q
├── deploy/
│   ├── docker-compose.yml              # n8n + volumes for testing on the Q
│   ├── Dockerfile                      # custom n8n image with our nodes baked in
│   └── sync.sh                         # rsync script
├── experiments/
│   └── test-router.mjs                 # the smoke test we already validated
└── sketches/
    └── integration-test.ino            # MCU sketch used by the bridge integration suite
```

Monorepo (single repo with `packages/`) using npm workspaces. Settled on npm (not pnpm) because the n8n community nodes workflow is friendlier to plain `npm` — split later if the bridge package gets independent uptake.

### Sync to UNO Q

Use `rsync` over SSH. Assumes SSH already works (username `arduino`, hostname `linucs` or the IP). The script below implements **Pattern A** (see "How n8n sees our packages" below): sync the built `dist/` folders into `deploy/custom/` on the Q and restart the container. No image rebuild.

See [deploy/sync.sh](deploy/sync.sh) for the real script. In shape:

```bash
# deploy/sync.sh — shape (see the real file for the current version)
#!/usr/bin/env bash
set -euo pipefail
HOST="${UNOQ_HOST:-arduino@linucs.local}"
REMOTE_DIR="${UNOQ_DIR:-/home/arduino/n8n}"

# Build on PC (npm workspaces)
npm run build

# Sync the deploy dir (docker-compose files, etc.)
rsync -av --delete \
  --exclude node_modules --exclude .git --exclude custom \
  ./deploy/ "$HOST:$REMOTE_DIR/"

# Wipe stale bundles first — n8n scans custom/ recursively for *.node.js and
# would otherwise load leftovers from previous layouts alongside the new ones.
ssh "$HOST" "rm -rf $REMOTE_DIR/custom/packages && \
  mkdir -p $REMOTE_DIR/custom/packages/bridge/dist $REMOTE_DIR/custom/packages/n8n-nodes/dist"

# Sync package.json + dist/ for each package (package.json carries the "n8n" entry).
rsync -av packages/bridge/package.json    "$HOST:$REMOTE_DIR/custom/packages/bridge/"
rsync -av packages/bridge/dist/           "$HOST:$REMOTE_DIR/custom/packages/bridge/dist/"
rsync -av packages/n8n-nodes/package.json "$HOST:$REMOTE_DIR/custom/packages/n8n-nodes/"
rsync -av packages/n8n-nodes/dist/        "$HOST:$REMOTE_DIR/custom/packages/n8n-nodes/dist/"

# Apply the dev override (bind-mount ./custom) and restart n8n to re-scan.
ssh "$HOST" "cd $REMOTE_DIR && \
  docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d n8n && \
  docker compose -f docker-compose.yml -f docker-compose.dev.yml restart n8n"
```

### Installing n8n on the Q (first time)

App Lab is not involved — we install n8n as a plain Docker service, managed by `docker compose` from the board's shell. Docker is pre-installed on the Q and the `arduino` user is in the `docker` group (the Docker socket shows `srw-rw---- docker`), so `sudo` is unnecessary.

```bash
mkdir -p ~/n8n && cd ~/n8n
# Place docker-compose.yml here (see skeleton below)
docker compose up -d
# n8n is now on http://<q-ip>:5678 — first load redirects to /setup to create the owner account.
```

Once the deploy/sync pipeline is running, this becomes a one-time bootstrap — further changes flow through `sync.sh`.

### docker-compose skeleton for running n8n on the Q

Two files, layered: the base is prod-ready, dev layers a bind-mount on top.

`deploy/docker-compose.yml` (prod base — also what a clean clone gets):

```yaml
services:
  n8n:
    image: n8nio/n8n:latest
    restart: unless-stopped
    ports:
      - "5678:5678"
    volumes:
      - /var/run/arduino-router.sock:/var/run/arduino-router.sock
      - n8n_data:/home/node/.n8n               # workflows + credentials persistence
    environment:
      # Auth is handled by n8n's built-in user management — /setup on first launch.
      - GENERIC_TIMEZONE=Europe/Malta
      - TZ=Europe/Malta
      - N8N_COMMUNITY_PACKAGES_ENABLED=true
      - N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true   # mandatory for UnoQTool (AI-agent tool node)
      - N8N_SECURE_COOKIE=false                        # LAN-only access over HTTP; remove if fronted by TLS

volumes:
  n8n_data:
```

`deploy/docker-compose.dev.yml` (dev override — adds the Pattern A bind-mount):

```yaml
services:
  n8n:
    volumes:
      - ./custom:/home/node/.n8n/custom:ro
```

Dev runs: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d` (sync.sh does this automatically). Prod runs: plain `docker compose up -d`.

**Gotcha:** without the `n8n_data` volume, every restart wipes workflows *and* the community nodes installed from the UI. Don't skip it.

### How n8n sees our packages

n8n loads community nodes from `/home/node/.n8n/custom/`. Any npm package in there whose `package.json` declares an `"n8n"` entry point is discovered at startup. We use two patterns — one for dev, one for prod:

**Pattern A — bind-mount for dev loop.** Build the packages on PC into `packages/*/dist`, rsync `package.json` + `dist/` to `deploy/custom/packages/*/` on the Q, bind-mount that folder into the container via `docker-compose.dev.yml`. `sync.sh` wipes `custom/packages` before each sync so stale files from earlier layouts don't get picked up by n8n's recursive `.node.js` scan.

After an `rsync + docker compose restart n8n`, the new nodes appear in the UI. No image rebuild.

**Each node file is a self-contained CJS bundle.** Under Pattern A there's no `npm install` in `custom/`, so the node can't rely on `node_modules` being there to resolve `@raasimpact/arduino-uno-q-bridge` or `@msgpack/msgpack` at load time. `packages/n8n-nodes/scripts/build.mjs` uses **esbuild** to bundle each `*.node.ts` into a standalone CJS file with the bridge and msgpack inlined; `n8n-workflow` is the only external (provided by the n8n runtime). Side effects worth remembering:

- Each `*.node.js` has its own bundled copy of `BridgeManager`, so the module-level singleton would not actually be shared across nodes. `BridgeManager.getInstance()` stashes the instance on `globalThis` under a `Symbol.for(...)` key to make it a true process-wide singleton.
- Removing `"type":"module"` from `packages/n8n-nodes/package.json` is what makes Node treat the bundled `.js` as CJS (so the `require("n8n-workflow")` resolves via the normal Node CJS lookup chain inside the container).
- TypeScript runs as `tsc --noEmit` only (pure typecheck). esbuild owns the emit.

**Pattern C — GUI install from inside n8n (production).** Settings → Community Nodes → Install `n8n-nodes-uno-q`. n8n pulls it from npm along with the bridge as a transitive dependency, and persists the install inside the `n8n_data` volume. Updates are a one-click affair from the same UI.

This is the shipping story: a user who clones the repo (or just grabs `deploy/docker-compose.yml` on its own) runs `docker compose up -d` and installs the node from the UI. No build on the Q, no cross-arch image rebuild from a Mac dev box, no bind-mount.

**Why not a custom Docker image?** Earlier drafts had a "Pattern B" where `Dockerfile` baked `npm install -g n8n-nodes-uno-q` on top of `n8nio/n8n:latest`. Rejected: building that image on a Mac for the UNO Q's arch requires either buildx cross-compilation or building on the Q itself — both fragile, both avoidable once the package is on npm and Pattern C exists.

### Node never runs directly on the Q

Node.js is not installed on the UNO Q outside of containers. All Node-based testing happens either:

- **SSH tunnel** (bridge/integration tests from the PC):
  ```bash
  rm -f /tmp/arduino-router.sock && ssh -N -L /tmp/arduino-router.sock:/var/run/arduino-router.sock arduino@linucs.local &
  UNOQ_SOCKET=/tmp/arduino-router.sock npm run test:integration -w packages/bridge
  ```
- **n8n container on the Q** (for n8n node testing) — via the deploy pipeline below.

Never reference `/var/run/arduino-router.sock` as a path in test commands or scripts run from the PC; that path only exists on the Q and in containers with the socket bind-mounted.

### Testing loop

1. Edit code on PC in Claude Code.
2. `pnpm build` locally (catches type errors fast).
3. `./deploy/sync.sh` pushes the new `dist/` to the Q and restarts the n8n container.
4. Browser to `http://<uno-q-ip>:5678`, test workflow.
5. MCU sketch changes: edit in App Lab (or via arduino-cli), redeploy separately — the sketch is independent of the n8n container.

### Debug flow: isolate by layer

When something stops working, don't guess. Walk from the lowest layer up; the first layer that fails is where the bug lives. Six layers:

**Layer 0 — MCU sketch.** Add `Serial.println()` traces inside your bridged functions and watch them from App Lab's serial console, or `arduino-cli monitor` on a side terminal. Don't monitor `/dev/ttyHS1` — that's the router's exclusive channel. If you need a second serial output for debug, route it on a different UART.

**Layer 1 — router reachable.** The smoke test already in `experiments/test-router.mjs` is the canary. If it no longer prints `[1, 1, null, '<version>']`, the problem is lower than your code: router crashed, socket permissions changed, container can't reach the socket. `ssh arduino@linucs "sudo systemctl status arduino-router"` and `ls -la /var/run/arduino-router.sock` sort this out.

**Layer 2 — bridge package.** Two tiers of tests:

- **Unit** (fast, CI-friendly): mock transport, no real socket. Test msgid allocation, timeout handling, reconnect backoff, error propagation.
- **Integration** (manual, against the real Q): `pnpm --filter bridge test:integration`. Covers register/call/notify round-trips, socket disconnect behaviour, multiple concurrent calls.

**Layer 3 — n8n nodes on PC (no Q in the loop).** You don't need to deploy to the Q to debug node UI, schema validation, or trigger refcounting. Run n8n locally pointing at a mock:

```bash
pnpm --filter n8n-nodes build
N8N_CUSTOM_EXTENSIONS=/abs/path/to/packages/n8n-nodes/dist npx n8n start
```

The socket isn't available on the PC. Two options:

- **SSH tunnel the socket:** `rm -f /tmp/arduino-router.sock && ssh -N -L /tmp/arduino-router.sock:/var/run/arduino-router.sock arduino@linucs.local &`, then configure the node to use `/tmp/arduino-router.sock`. Higher latency but end-to-end realism.
- **Local mock router:** a ~50-line Node.js script that speaks msgpack-rpc and returns canned responses. Faster iteration, no Q required. Worth writing once and committing under `experiments/mock-router.mjs`.

**Layer 4 — n8n in the container on the Q.** Only after layer 3 is clean. Bugs here are typically bind-mount paths, permissions, env vars.

```bash
ssh arduino@linucs 'docker compose -f ~/n8n/docker-compose.yml logs -f n8n'
# In another window, exec into the container to inspect:
ssh arduino@linucs 'docker compose -f ~/n8n/docker-compose.yml exec n8n ls /home/node/.n8n/custom'
```

**Layer 5 — Tools Agent with a real LLM.** Last layer because it's non-deterministic and costs tokens. Recommendations:

- Use a local LLM via Ollama for the dev loop — free, offline, fine for testing tool-calling behaviour. Reserve paid models (Claude, GPT) for final polish.
- Enable `Return Intermediate Steps` on the agent node to see the reasoning trace — most bugs here are "the LLM didn't know when to call the tool" and the fix is in the tool description, not the code.
- When the LLM picks wrong tools or wrong params, rewrite the description before touching the code. 90% of agent debugging is prose.

### Fast-triage cheat sheet

| Symptom | First check |
|---|---|
| Nodes don't appear in n8n UI | Layer 4: is `./custom` bind-mounted and does `ls` show your package? Is the `"n8n"` entry point declared in `package.json`? |
| "Cannot connect to socket" | Layer 1: is the socket there and `rw` for all? Layer 4: is it bind-mounted into the container? |
| Call returns "method not available" | Layer 0: is the sketch actually running and has the MCU rebooted since you last changed `Bridge.provide(...)`? |
| Trigger fires twice for one MCU event | Layer 3: singleton refcount bug — two trigger nodes registered the same method. |
| Agent ignores tools that should obviously apply | Layer 5: rewrite the tool description in active voice, start with a verb, include an example. |

---

## 8. Open items and risks

### To verify before significant coding

- [ ] RAM variant of my UNO Q (2 GB vs 4 GB). `free -h` on the board.
- [ ] How does the router handle NOTIFY forwarding when the registrant is temporarily disconnected? Does it queue, drop, or error? Test empirically.
- [ ] How are bytes/buffers serialized through the router for binary data (e.g., I2C reads)? msgpack has a `bin` type; confirm both Python `Bridge` and `Arduino_RouterBridge` round-trip it faithfully.
- [ ] Capitalization of the apps directory on my Q (`arduinoApps` / `ArduinoApps` / `Arduino Apps`). `ls /home/arduino/`.
- [x] npm scope name — **`@raasimpact`** (decided and used throughout).
- [ ] **Method introspection**: does any router version have a `$/methods` or equivalent endpoint that lists currently registered methods with metadata? If yes, Tool node config simplifies dramatically. If not (current state), manual config is fine for v1 but worth raising as a feature request upstream.
- [ ] **Arduino UNO Q Respond node** (v2, §6.6): ship the companion to Trigger's *Wait for Respond Node* sub-mode. `PendingRequests` singleton is already in place — the Respond node just needs to read `_unoQRequest.msgid` and call `resolve`/`reject`.
- [ ] **Arduino UNO Q Tool node** (v2, §6.4): flesh out the current scaffold into a real `ai_tool` sub-node. `supplyData` must return a `DynamicStructuredTool` that wraps `bridge.call(method, params)`, with a per-tool description + parameter schema (zod or JSON Schema) configured by the user.

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

## 11. Conventions for Claude Code

- **Language:** TypeScript for both packages. Source in `src/`, build to `dist/`.
- **Style:** ESLint + Prettier with defaults, no bikeshedding.
- **Tests:** Vitest. At least smoke coverage before each publish.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`). Helps if we later adopt Changesets for versioning.
- **Versioning:** start at `0.1.0`. Semver strict once we hit `1.0.0`.
- **License:** MIT (revisit if Arduino's GPL router imposes anything on a protocol-level client — it shouldn't, but worth a quick legal sanity check before first publish).
- **Update this file** whenever a decision changes. Don't let it go stale.