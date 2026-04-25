# n8n-nodes-arduino-cloud

**Give your AI agent persistent memory of what your hardware did.** This package wires [Arduino Cloud](https://cloud.arduino.cc) into n8n so an AI Agent — through the standard Tools Agent connector — can read, write, and query historic values on any Arduino Cloud-connected board (Nano 33 IoT, MKR WiFi 1010, Portenta, UNO R4 WiFi, Nano ESP32, …) with safety rails for the LLM. The same nodes work for non-agent workflows too: react to a property update, write a value back, or pull last-hour history into a dashboard.

This package is independent of `n8n-nodes-uno-q`. Install both side by side if you have a UNO Q *and* Cloud-connected boards — the two address different semantics (LAN-local RPC vs. cloud pub/sub) and don't share state.

Built on the two official Arduino JS SDKs:

- [`@arduino/arduino-iot-client`](https://www.npmjs.com/package/@arduino/arduino-iot-client) — REST. Property Get / Set / GetHistory, Things and Properties listing.
- [`arduino-iot-js`](https://github.com/arduino/arduino-iot-js) — MQTT-over-WebSocket realtime. Powers the trigger node.

## Requirements

- n8n 1.x with community nodes enabled
- An [Arduino Cloud API key](https://cloud.arduino.cc/home/api-keys) (Client ID + Client Secret). The default scope `iot:devices,iot:things,iot:properties` covers everything the package does.
- Node ≥ 20 in the n8n container (the official `n8nio/n8n` image already meets this)

## Install

From n8n: **Settings → Community Nodes → Install** → type `n8n-nodes-arduino-cloud` → Install.

To use the **Arduino Cloud** node as an AI Agent tool, also set `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true` on the n8n process. The [sample docker-compose](https://github.com/raas-impact/n8n-uno-q/blob/main/deploy/n8n/docker-compose.yml) already sets it.

## Credential — `Arduino Cloud OAuth2 API`

One credential covers both nodes. Create it under **Settings → Credentials → New → Arduino Cloud OAuth2 API**:

| Field | Meaning |
|---|---|
| Client ID | The `client_id` from your Arduino Cloud API key. |
| Client Secret | The `client_secret`. n8n stores it encrypted. |
| Organization ID | Optional `X-Organization` header for multi-org accounts. Leave blank otherwise. |

**Test Connection** mints a token via OAuth2 client_credentials and lists Things — succeeds with `Connected — N Thing(s) visible` or surfaces the exact failure (bad credentials, network, etc.).

The same credential drives REST calls *and* the MQTT-over-WS subscriptions; you don't need a second one for the trigger.

## Nodes

### Arduino Cloud (action)

Reads and writes Thing Properties. **Marked `usableAsTool: true`** — drops into a Tools Agent's tool connector without a separate wrapper node. Three operations on the **Property** resource:

| Operation | What it does | LLM-friendly use |
|---|---|---|
| **Get** | Read the current value of a property. | "What is the temperature?" |
| **Set** | Publish a new value. | "Turn the heater on." |
| **Get History** | Time-series values for a window. | "Was the temperature unusual at 3 am yesterday?" |

**Thing** and **Property** dropdowns are populated live via the REST API once the credential is set; you don't paste UUIDs by hand.

**Value coercion** — the *Value* field accepts an n8n expression. By default the node parses literal strings (`true`/`false`, `42`, `3.14`, JSON object/array) into the corresponding native types; you can force a specific type with the *Value Type* dropdown if Auto guesses wrong (e.g. a digit-only string that must stay a string). For Location and Color variables, pass an object via expression — `{{ { lat: 45.5, lon: 9.2 } }}` for `LOCATION`, `{{ { hue: 270, sat: 80, bri: 128 } }}` for `COLOR_HSB`.

**GetHistory** defaults: leave **From** and **To** blank to query "last hour up to now". Both fields accept any value n8n's expression editor produces (ISO-8601 string, JS Date, Unix epoch).

### Arduino Cloud Trigger

Fires a workflow on each property update. Backed by `arduino-iot-js`'s MQTT-over-WebSocket subscription to the Arduino Cloud broker — no polling, no webhook proxy.

Two fields: **Thing** (UUID via dropdown) and **Property Variable Name** (the `variable_name` from the sketch — e.g. `temperature` — *not* the property UUID). The picker shows both for clarity and writes the variable name to the parameter.

The emitted JSON shape downstream nodes see is:

```json
{
  "thingId": "<uuid>",
  "variableName": "temperature",
  "value": 21.5,
  "receivedAt": "2026-04-25T15:00:00.000Z"
}
```

`value` matches the property's declared type — boolean for STATUS, number for INT/FLOAT, object for COLOR_HSB / LOCATION.

**Connection sharing.** Multiple triggers in the same workflow that point at the same credential collapse to a single MQTT connection (see [§13.7 in the master plan](https://github.com/raas-impact/n8n-uno-q/blob/main/docs/master-plan/13-arduino-cloud.md) for the architecture). You don't need to worry about exhausting MQTT slots if you have a dozen triggers.

## AI tool use — Property Guard and Rate Limit

The point of `usableAsTool: true` is that an LLM picks parameters at runtime. That's powerful and dangerous — the LLM might pick a thermostat setpoint of 99°C, or call the same actuator a hundred times in a tight reasoning loop. Two affordances mitigate that.

### Property Guard

A small JavaScript predicate that runs at invocation time. Variables in scope:

| Name | Type | Meaning |
|---|---|---|
| `operation` | string | `"get"`, `"set"`, or `"getHistory"`. |
| `thingId` | string | |
| `propertyId` | string | |
| `value` | any | The parsed Value (Set only; `undefined` for Get/GetHistory). |
| `budget` | object | `budget.used("minute"\|"hour"\|"day")`, `budget.remaining`, `budget.resetsInMs`. See Rate Limit below. |

Return:

- `true` / `undefined` / `null` — allow the call through.
- a **string** — reject with that exact message. The string is fed back to the LLM as the tool output, so the agent can read it and self-correct (e.g. "Refused: setpoint must be 15-26 degrees").
- `false` — generic rejection.
- `throw` — hard error (the workflow fails with that error).

```javascript
// Clamp a thermostat setpoint.
if (operation === "set" && (value < 15 || value > 26)) {
  return "Refused: setpoint must be between 15 and 26 degrees.";
}
// Block writes after 11pm local.
if (operation === "set" && new Date().getHours() >= 23) {
  return "Refused: no writes after 23:00.";
}
return true;
```

The guard runs without a sandbox — same trust model as the n8n Code node. **Only the Property Guard's return value is passed back to the LLM**; rate-limit short-circuits and "refused" outputs flow through the same channel, so the agent sees a uniform "this didn't go through, here's why" signal regardless of which gate caught it.

### Rate Limit

Sliding-window cap: **Max Calls** within a **Per** window (Minute / Hour / Day). Excess calls short-circuit with a `Refused: rate limit of N per X exceeded. Retry in ~Ys.` string the LLM reads.

Counters are in-memory per n8n process, **keyed per (node, thingId, propertyId, operation)**. Two consequences:

- Get and Set on the same property have *independent* budgets. A user reading the value to verify a write doesn't burn the write budget — and vice versa.
- Restarting n8n (or `docker compose restart`) resets every counter. Counters are not shared across queue-mode workers.

For finer policies (priority reservation, soft caps without hard enforcement, "warn the LLM at 80% of the limit"), read `budget.remaining` / `budget.used(window)` from the Property Guard.

**Gate ordering**: Rate Limit → Property Guard → REST call. A Rate Limit rejection short-circuits the guard. A guard rejection does **not** consume rate-limit budget (otherwise a guard like "no writes after 23:00" would burn through the cap on every refusal).

### `$fromAI` expressions

Any node parameter can be filled by the LLM at call time using `$fromAI('name', 'description', 'type')`. Typical pattern:

| Field | Value |
|---|---|
| Thing | static dropdown choice |
| Property | static dropdown choice |
| Value | `={{ $fromAI('value', 'Setpoint in degrees Celsius. Range 15-26.', 'number') }}` |

The LLM sees the description and produces a value at invocation. Pair it with a Property Guard that validates the same range — descriptions guide the agent, guards enforce.

### Tool description

The text in the node's **Description** field (Settings → bottom of the node) is what the LLM reads when deciding whether to invoke the tool. 90% of agent-ergonomics bugs are prose, not code. Start with a verb, state units and ranges, include an example invocation. *"Set the kitchen thermostat to a setpoint between 15 and 26°C. Example: 21."* beats *"Sets a property"*.

## Limits and caveats

- **Arduino Cloud REST budget**: 10 requests/sec per OAuth2 client. The package automatically queues requests against a per-credential token bucket so a workflow with many parallel nodes won't 429 — they serialise transparently. A side effect: bursts above 10 calls/sec see ~100 ms added latency per excess call.
- **Property Guard runs without a sandbox** — same trust model as n8n's Code node. Don't paste guards from untrusted sources.
- **Rate Limit counters are in-memory per process** — they reset on container restart and are not shared across queue-mode workers.
- **Trigger connection sharing happens per credential id**. If the same Arduino Cloud account is wired up via two separate n8n credentials (e.g. for tagging purposes), you get two MQTT connections and double the broker load. Use one credential.
- **`Set` is asynchronous to the device**: `propertiesV2Publish` returns when the cloud accepts the value; whether the device receives and applies it depends on the device being online. The Trigger node delivers the value back as soon as the broker fans it out, which is your best signal that the round-trip completed.

## Disjoint from the UNO Q stack

This package does not depend on `n8n-nodes-uno-q` and does not replace it. The two address different semantics:

| Need | Cloud package | UNO Q package |
|---|---|---|
| Telemetry: device → workflow on a value change | ✅ native (MQTT trigger) | ✅ via `Arduino UNO Q Trigger` |
| State: shared variable between workflow and device | ✅ native (Properties) | works, not the native idiom |
| RPC: typed args, return value, sub-10 ms LAN-local round-trip | ❌ not the model | ✅ native (`Arduino UNO Q Call` / Method) |
| Works offline | ❌ requires internet | ✅ |

Install both if you have both kinds of hardware. They run side by side with no coupling.

## Links

- Master plan, including the wedge analysis behind this package's narrow v1 scope: [`docs/master-plan/13-arduino-cloud.md`](https://github.com/raas-impact/n8n-uno-q/blob/main/docs/master-plan/13-arduino-cloud.md)
- Companion package for UNO Q workflows: [`n8n-nodes-uno-q`](https://github.com/raas-impact/n8n-uno-q/tree/main/packages/n8n-nodes)

## License

MIT.
