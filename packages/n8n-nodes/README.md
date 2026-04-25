# n8n-nodes-uno-q

n8n community nodes for the [Arduino UNO Q](https://store.arduino.cc/products/uno-q) — read sensors, drive GPIO, call I²C devices, and expose MCU methods as tools for n8n's AI Agent. Workflows talk directly to the on-board microcontroller via `arduino-router`, no Python proxy in the way.

n8n can run on the Q itself (unix socket, same host) or on any other machine that can reach the Q over TCP via a relay container. Two relay flavours ship with this project:

- [**`deploy/relay/`**](https://github.com/raas-impact/n8n-uno-q/tree/main/deploy/relay) — plain `socat`, for trusted LANs. No auth, no encryption.
- [**`deploy/relay-mtls/`**](https://github.com/raas-impact/n8n-uno-q/tree/main/deploy/relay-mtls) — `stunnel` with mutual TLS, for untrusted networks. Requires issuing a client cert via the bundled [`pki`](https://github.com/raas-impact/n8n-uno-q/tree/main/deploy/relay-mtls/pki) wrapper.

All three setups (unix socket, plain TCP, mTLS) use the same nodes and the same `Arduino UNO Q Router` credential — the transport choice and the optional *Use TLS* toggle pick which one.

## Requirements

- n8n 1.x (community-nodes-enabled)
- An `arduino-router` reachable either via a unix socket (same-host setup) or TCP (remote setup — see the relay container linked above)
- MCU sketch using [`Arduino_RouterBridge`](https://www.arduinolibraries.info/libraries/arduino_router-bridge) to register methods with `Bridge.provide(...)`
- Node ≥ 20 in the container (the official `n8nio/n8n` image already meets this)

## Install

From n8n: **Settings → Community Nodes → Install** → type `n8n-nodes-uno-q` → Install.

n8n fetches the package (and the bridge as a transitive dep) from npm and persists the install in its `n8n_data` volume. Updates are a click away from the same page.

To enable the **Arduino UNO Q Method** node as an AI Agent tool, set `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` on the n8n process (already set in the [sample docker-compose](https://github.com/raas-impact/n8n-uno-q/blob/main/deploy/n8n/docker-compose.yml)).

## Credential — `Arduino UNO Q Router`

Each node needs one `Arduino UNO Q Router` credential assigned. Create it under **Settings → Credentials → New → Arduino UNO Q Router**:

| Field | When shown | Meaning |
|---|---|---|
| Transport | always | `Unix Socket (local)` for same-host, `TCP` for remote (plain or mTLS — picked by the *Use TLS* toggle below). |
| Socket Path | Transport = Unix | Path to `arduino-router`'s unix socket. Default `/var/run/arduino-router.sock` fits the [sample docker-compose](https://github.com/raas-impact/n8n-uno-q/blob/main/deploy/n8n/docker-compose.yml). |
| Host | Transport = TCP | Hostname or IP of the Q running the relay container. |
| Port | Transport = TCP | TCP port of the relay container. Default `5775`. |
| Use TLS (mTLS) | Transport = TCP | Toggle on for Variant C (mTLS) relays. See below. |
| CA / Client Cert / Client Key | Use TLS = on | PEM contents from your n8n client bundle (see below). |

**Test Connection** runs `$/version` end-to-end over the configured transport and returns the router's version on success, or a specific failure message (socket not found, connection refused, timeout, etc.).

### mTLS (Variant C)

Plain TCP is unauthenticated and unencrypted — only safe on a trusted LAN. For untrusted networks, enable **Use TLS (mTLS)** to speak to a Variant C [`stunnel` relay](https://github.com/raas-impact/n8n-uno-q/tree/main/deploy/relay-mtls). Three extra fields appear:

1. **CA Certificate (PEM)** — paste `ca.pem` from your n8n client bundle.
2. **Client Certificate (PEM)** — paste `client.pem`.
3. **Client Key (PEM)** — paste `client.key`. n8n stores the key encrypted.

All three come from the same bundle issued by the [`pki`](https://github.com/raas-impact/n8n-uno-q/tree/main/deploy/relay-mtls/pki) wrapper: running `./pki add n8n laptop` produces `pki/out/n8n/laptop/{ca.pem,client.pem,client.key}`. Paste the *contents* of each file (not the path) into the matching field.

If any of the three is missing when **Use TLS** is on, the node errors on first use with a message naming the empty field(s). *Test Connection* catches the same case before you save.

Turning **Use TLS** back off ignores any stale cert data — the descriptor reverts to plain TCP on the same host + port.

### Multiple Qs

Define one credential per Q (`Kitchen Q`, `Garage Q`, …) and assign a different one to each node in a workflow. A workflow that reads a temperature sensor on the kitchen Q and fires a fan relay on the garage Q is two nodes, one credential each — no other coordination needed.

## Nodes

- **Arduino UNO Q Call** — call an MCU method from a workflow. Pass parameters typed or as a JSON array.
- **Arduino UNO Q Trigger** — fire a workflow when the MCU calls or notifies. Two modes:
  - *Notification* — fire-and-forget (`Bridge.notify(...)` on the MCU side).
  - *Request* — the MCU does `Bridge.call(...)`; choose either immediate-ack or *Wait for Respond Node* to compute a response from workflow data.
- **Arduino UNO Q Respond** — companion to Trigger's *Wait for Respond Node* mode. Same idea as *Respond to Webhook*, but over the router socket. Takes no credential of its own — it matches the pending request by msgid carried on the incoming item.
- **Arduino UNO Q Method** — exposes one MCU method as a tool for the [Tools AI Agent](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/tools-agent/). The LLM fills parameter values at runtime via `$fromAI('name', 'description', 'type')` expressions.

## AI Agent usage

Add an *Arduino UNO Q Method* node per MCU method you want the agent to have access to. Wire each to the Agent's Tool port and fill:

- **Description** — clear, action-oriented prose. The LLM reads this to decide when to call.
- **Method** — the MCU method name (e.g. `set_led_state`).
- **Parameters** — for each argument the LLM should provide, put `{{ $fromAI('name', 'description', 'type') }}` in the Value field. Static values pass through unchanged.
- **Idempotent** — the one retry flag. See [Idempotency and retry](#idempotency-and-retry) below.
- **Method Guard** — optional JS predicate that decides whether each invocation may proceed. See [Method guard](#method-guard) below.
- **Rate Limit** — optional cap on invocations per minute/hour/day. See [Rate limit and budget](#rate-limit-and-budget) below.

Example for an LED on/off tool:

| Field | Value |
|---|---|
| Description | Turns the onboard LED on or off. Pass true to turn on, false to turn off. |
| Method | `set_led_state` |
| Parameter #1 | Type: Boolean, Value: `{{ $fromAI('state', 'true for on, false for off', 'boolean') }}` |
| Idempotent | `true` — setting the LED to `true` twice leaves it on |

## Idempotency and retry

The **Idempotent** checkbox (default `false`, fail-closed) answers one question: *if the socket drops and the bridge replays this call with the same params, does the MCU end up in the same state?*

- **Yes** → tick the box. The bridge auto-retries on mid-call `ConnectionError` within the remaining timeout budget. Covers absolute writes (`set_valve(closed)`), pure reads, anything whose end-state is deterministic.
- **No** → leave it off. Relative moves, pulses, counters — a replay would double the effect. The `ConnectionError` surfaces and a human (or the LLM, per your description) decides what to do.

The *Arduino UNO Q Call* node (non-AI) has the same top-level **Idempotent** checkbox. For details of the bridge-level retry contract (how many retries, budget handling, what never retries), see the bridge README's [Retry and idempotency](https://github.com/raas-impact/n8n-uno-q/blob/main/packages/bridge/README.md#retry-and-idempotency) section.

## Method guard

An AI Agent fills `$fromAI(...)` parameters at runtime — there is no workflow-visible node to intercept and validate. The **Method Guard** is a small JavaScript body you can attach to a Method node to decide, at invocation time, whether the call should proceed. It gets three variables in scope:

- `method` — the MCU method name (string).
- `params` — positional arguments, coerced to their declared types (array).
- `budget` — a read-only view of recent call history for this node (see [Rate limit and budget](#rate-limit-and-budget) below).

Typical uses:

- **Argument validation** — clamp numeric ranges, reject destructive strings, require non-empty values.
- **Time-of-day / calendar gating** — deny calls outside operating hours.
- **External-state checks** — read a flag, poll a cache, forbid calls during a maintenance window.
- **Traffic-aware rejection** — using `budget.used(window)` or `budget.remaining`, reserve quota for higher-priority requests or apply a soft cap without committing to a hard one.

Return values decide the fate of the call:

- `true` / `undefined` / `null` — allow.
- `false` — reject with a generic message.
- any string — reject with that exact string; when wired to an Agent, the string is fed back as tool output so the LLM can self-correct.
- `throw` — the thrown message surfaces prefixed with `"Method guard threw:"`.

A **rejected call does not consume rate-limit budget** — only calls that pass both gates and reach the MCU count toward `maxCalls`.

Example — clamp a speed argument and close the door outside business hours:

```js
if (typeof params[0] !== 'number') return 'Refused: speed must be a number';
if (params[0] < 0)   return 'Refused: speed must be >= 0';
if (params[0] > 100) return 'Refused: max speed is 100';

const hour = new Date().getHours();
if (hour < 8 || hour >= 18) return 'Refused: outside operating hours';

return true;
```

The guard runs **without a sandbox**, same trust model as n8n's Code node. Leave the field empty to skip. The *Arduino UNO Q Call* node has no equivalent — non-AI workflows can gate with standard IF/Code nodes before the Call.

## Rate limit and budget

An LLM driving the Agent can issue tool calls faster than a microcontroller wants to handle them — bursts from retry loops, exploratory prompting, or just an eager model can swamp the MCU or eat actuator life. The **Rate Limit** field on the Method node caps invocations in a sliding window:

- **Max Calls** — integer, e.g. `10`.
- **Per** — `minute`, `hour`, or `day`.

When exceeded, the node returns `{ refused: true, error: "Refused: rate limit of 10 per minute exceeded. Retry in ~Xs." }` — the same rejection shape the Method Guard uses, so the LLM can read it and back off. The check runs **before** the Method Guard, so rate-limited calls never execute guard code and never reach the MCU.

Counters are in-memory per n8n process. They reset when the container restarts, and they are **not shared across queue-mode workers** (one more reason queue mode is unsupported, see [Limits](#limits)).

### `budget` in the Method Guard

The Method Guard sees a `budget` object whether or not the Rate Limit field is configured, so you can build traffic-aware policies in either setup:

| Property | Type | Meaning |
|---|---|---|
| `budget.used(window)` | `(window: 'minute' \| 'hour' \| 'day') => number` | Prior successful calls in the last `window`. Always available. |
| `budget.remaining` | `number \| null` | Calls left under the Rate Limit field. `null` when no cap is configured. |
| `budget.resetsInMs` | `number \| null` | Ms until the oldest in-window call rolls off. `null` when the window is empty or no cap is configured. |

Three patterns you can compose:

```js
// Pattern 1 — hard cap (no guard needed). Set Rate Limit and leave guard empty.

// Pattern 2 — soft cap without committing to enforcement. Works even with no
// Rate Limit set, since budget.used always tracks history.
if (budget.used("minute") >= 20) return "Refused: soft cap at 20/min";
return true;

// Pattern 3 — prioritise. Hard cap plus reservation for critical calls.
// Rate Limit is set (e.g. 10/min); this guard keeps the last 3 slots for
// params that matter most.
if (budget.remaining !== null && budget.remaining < 3 && params[0] < 50) {
  return "Refused: near quota, reserving remaining calls for higher priority";
}
return true;
```

## Limits

- **Per-process singleton bridge — n8n queue mode is not supported.** One `BridgeManager` instance per n8n process keeps a connection per credential and refcounts `provide` / `onNotify` subscriptions. With queue mode, each worker would register separately and the MCU would see duplicate registrations. Rate-limit counters are per-process for the same reason.
- **No authentication on the TCP transport.** The relay container is a plain socat proxy — deploy only on trusted networks, or restrict with firewall rules / an SSH tunnel.

## See also

- [`n8n-nodes-arduino-cloud`](https://www.npmjs.com/package/n8n-nodes-arduino-cloud) — companion package for the hosted [Arduino Cloud](https://cloud.arduino.cc) story (Nano 33 IoT, MKR WiFi 1010, Portenta, UNO R4 WiFi, Nano ESP32, …). Read / write Thing Properties, react to MQTT property updates, and expose properties as AI Agent tools with the same Property Guard + Rate Limit safety rails this package ships for the UNO Q. Independent from this package — install both side by side if you have UNO Q hardware *and* other Arduino Cloud-connected boards. The two address different semantics (sub-10 ms LAN-local RPC vs. cloud pub/sub) and don't share state.
- [`@raasimpact/arduino-uno-q-bridge`](https://www.npmjs.com/package/@raasimpact/arduino-uno-q-bridge) — the underlying pure-Node.js MessagePack-RPC client. Useful on its own for Node.js apps on the UNO Q (Express, Fastify, Bun, raw scripts).
- [Project repo and design docs](https://github.com/raas-impact/n8n-uno-q)

## License

MIT
