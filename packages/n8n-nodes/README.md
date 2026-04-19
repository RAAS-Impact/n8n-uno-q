# n8n-nodes-uno-q

n8n community nodes for the [Arduino UNO Q](https://store.arduino.cc/products/uno-q) — read sensors, drive GPIO, call I²C devices, and expose MCU methods as tools for n8n's AI Agent. Workflows talk directly to the on-board microcontroller via `arduino-router`, no Python proxy in the way.

## Requirements

- n8n running on the UNO Q (Docker) with `/var/run/arduino-router.sock` bind-mounted
- MCU sketch using [`Arduino_RouterBridge`](https://www.arduinolibraries.info/libraries/arduino_router-bridge) to register methods with `Bridge.provide(...)`
- Node ≥ 20 in the container (the official `n8nio/n8n` image already meets this)

## Install

From n8n: **Settings → Community Nodes → Install** → type `n8n-nodes-uno-q` → Install.

n8n fetches the package (and the bridge as a transitive dep) from npm and persists the install in its `n8n_data` volume. Updates are a click away from the same page.

To enable the **Arduino UNO Q Method** node as an AI Agent tool, set `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` on the n8n process (already set in the [sample docker-compose](https://github.com/raasimpact/n8n-uno-q/blob/main/deploy/docker-compose.yml)).

## Nodes

- **Arduino UNO Q Call** — call an MCU method from a workflow. Pass parameters typed or as a JSON array.
- **Arduino UNO Q Trigger** — fire a workflow when the MCU calls or notifies. Two modes:
  - *Notification* — fire-and-forget (`Bridge.notify(...)` on the MCU side).
  - *Request* — the MCU does `Bridge.call(...)`; choose either immediate-ack or *Wait for Respond Node* to compute a response from workflow data.
- **Arduino UNO Q Respond** — companion to Trigger's *Wait for Respond Node* mode. Same idea as *Respond to Webhook*, but over the router socket.
- **Arduino UNO Q Method** — exposes one MCU method as a tool for the [Tools AI Agent](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/tools-agent/). The LLM fills parameter values at runtime via `$fromAI('name', 'description', 'type')` expressions.

## AI Agent usage

Add an *Arduino UNO Q Method* node per MCU method you want the agent to have access to. Wire each to the Agent's Tool port and fill:

- **Description** — clear, action-oriented prose. The LLM reads this to decide when to call.
- **Method** — the MCU method name (e.g. `set_led_state`).
- **Parameters** — for each argument the LLM should provide, put `{{ $fromAI('name', 'description', 'type') }}` in the Value field. Static values pass through unchanged.

Example for an LED on/off tool:

| Field | Value |
|---|---|
| Description | Turns the onboard LED on or off. Pass true to turn on, false to turn off. |
| Method | `set_led_state` |
| Parameter #1 | Type: Boolean, Value: `{{ $fromAI('state', 'true for on, false for off', 'boolean') }}` |

## Limits

- Per-process singleton bridge — **n8n queue mode is not supported** (multiple workers each register separately, breaking the single-connection assumption).
- No per-node credentials resource yet; socket path is a per-node "Advanced" field. See the [project context](https://github.com/raasimpact/n8n-uno-q/blob/main/CONTEXT.md#65-credentials-deferred-to-v2) for the rationale.

## See also

- [`@raasimpact/arduino-uno-q-bridge`](https://www.npmjs.com/package/@raasimpact/arduino-uno-q-bridge) — the underlying pure-Node.js MessagePack-RPC client. Useful on its own for Node.js apps on the UNO Q (Express, Fastify, Bun, raw scripts).
- [Project repo and design docs](https://github.com/raasimpact/n8n-uno-q)

## License

MIT
