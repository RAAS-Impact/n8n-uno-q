## 13. Arduino Cloud integration (`n8n-nodes-arduino-cloud`)

**Status:** rescoped 2026-04-24 after honest wedge analysis (see §13.1). Not yet implemented. Separate npm package, not an extension of `n8n-nodes-uno-q`. Current priority per §11.

**Value claim.** What a user concretely gets from installing `n8n-nodes-arduino-cloud`:

- **Safe LLM control of Cloud-connected Arduino devices.** No other turnkey tool lets an AI Agent read and write variables on Arduino Cloud-connected boards (Nano 33 IoT, MKR WiFi 1010, Portenta, UNO R4 WiFi, Nano ESP32, and every other supported board) with safety rails. `ArduinoCloudProperty` is `usableAsTool: true` and ships the same safety primitives as `UnoQTool`: a user-editable **Property Guard** (JS predicate that rejects disallowed invocations, returning a string the LLM reads and self-corrects on) plus a sliding-window **Rate Limit** (caps how often the agent can write, with a retry-in-Xs message when exceeded). The `GetHistory` operation gives the agent time-series memory — *"is today unusual? what was the temperature at 3 am yesterday?"* — alongside live `Get` / `Set`. Spans the full Arduino Cloud device matrix; works regardless of which MCU is behind the Thing. **This is the differentiated capability the package is built around** — a gap no existing product (Arduino Cloud itself, Node-RED's Cloud nodes, n8n's built-in HA node, bespoke scripts) fills today.
- **A telemetry seam for non-UNO-Q Arduinos.** Non-agentic use case: any Arduino Cloud-supported board can wire n8n workflows to react to variable changes (`ArduinoCloudTrigger`) and write values back (`ArduinoCloudProperty.Set`), with no custom MCU firmware, no cross-board networking code, and no bridge server to maintain. Leans on Arduino's existing `ArduinoIoTCloud` MCU library and the two maintained JS SDKs (see §13.3).

What this package explicitly does **not** claim: it is not a replacement for the msgpack-rpc stack (different semantic — pub/sub vs. RPC; see the orthogonality table in §13.1), and not a general "integrate Arduino Cloud with n8n" framework (see §13.1 for framings rejected during the rescope and §13.5 for deferred scope).

### 13.1 Motivation and wedge analysis

An earlier framing of this section (2026-04-21) sold Cloud integration as a broad "every Arduino Cloud user is a prospect" story, which a deliberate pushback on that framing (2026-04-24) did not survive. The reasoning for the narrower scope is captured here so future readers don't reinflate it.

**Orthogonality with the msgpack-rpc stack.** Arduino Cloud and our `@raasimpact/arduino-uno-q-bridge` + `n8n-nodes-uno-q` stack address different semantic needs, not the same need at different levels:

| Semantic | Cloud covers | Our msgpack stack covers |
|---|---|---|
| Fire-and-forget telemetry (MCU → n8n) | ✅ native — property change → MQTT/WebSocket or webhook | ✅ — but reinvents what Arduino already ships |
| State synchronisation (shared variable) | ✅ native model | Works, not the native idiom |
| Imperative method invocation with typed args + return value + correlation ID + timeout | ❌ awkward DIY on top of pub/sub (request/response property pairs, no native msgid, no native timeout, round-trip through cloud broker) | ✅ native model |
| Sub-10 ms LAN-local round-trip | ❌ impossible (goes through Arduino's broker) | ✅ |
| Works offline | ❌ | ✅ |

The Cloud package is therefore **not a substitute for the msgpack stack** — it is the answer to *"I have a non-UNO-Q Arduino board (Nano 33 IoT, MKR WiFi 1010, Portenta, UNO R4 WiFi, Nano ESP32, etc.) and I want n8n to react to its events and write variables back"*, which the msgpack stack explicitly does not address. The two are disjoint; users with both kinds of hardware install both packages and the two run side by side with no coupling.

**The two surviving wedges.** A scenario-by-scenario honesty check (2026-04-24) rejected most of the combined-value pitches that were initially compelling because the audiences for them were either small, already-served-better elsewhere, or both. What remained:

1. **"React to a non-UNO-Q Arduino's events from n8n"** (the telemetry seam). Arduino's `ArduinoIoTCloud` MCU library already abstracts the cross-board networking problem for every supported board (SAMD21, nRF, RA4M1, STM32H7, ESP32, etc.). Building a custom cross-board RPC library would reinvent that wheel for the telemetry semantic specifically, where Cloud is mature and maintained. We only need the n8n-side nodes to consume it.
2. **AI agent with historical memory.** The differentiated workflow in our stack is Tools Agent over `UnoQTool`. Cloud's time-series storage (`SeriesV2HistoricData`) gives that agent historical context — *"is today unusual? what was the temperature at 3 am yesterday?"* — which no other turnkey tool delivers in-box. Small audience today, growing, and aligned with the persona the rest of the stack is built around.

**Framings rejected during the 2026-04-24 review** (so they're not relitigated):

- *"Dashboards for UNO Q values by mirroring to Cloud."* Grafana + InfluxDB (or Home Assistant) cover this strictly better for anyone who cares.
- *"Mobile app control via Cloud widgets."* Home Assistant's mobile app dominates the home-automation cohort; the residual audience is narrow.
- *"Remote access without the mTLS relay."* Tailscale is simpler than both Cloud and our mTLS story for users comfortable with Docker — which UNO Q users already are.
- *"Staged OTA rollouts across UNO Q fleets via workflow."* Nobody runs 20+ UNO Qs yet, and Arduino Cloud's own UI already has OTA for users who do.
- *"Cross-device orchestration with ESP32 / Portenta / Nano peers."* Home Assistant owns this persona.

See §13.5 for the node-level implications (what this scope cut out).

Confirmed 2026-04-21: no existing `n8n-nodes-arduino*` package on npm — we own the namespace. Workarounds today are HTTP Request + manual OAuth flow.

### 13.2 Why a separate package, not more nodes in `n8n-nodes-uno-q`

- Different audience: every Arduino Cloud user, not just UNO Q owners.
- Different credential (OAuth2 Client ID/Secret vs. router socket/TCP).
- Different transport (HTTPS + WebSocket/MQTT vs. msgpack-rpc on unix socket).
- Independent release cadence — Arduino Cloud API changes don't force a UNO Q bump and vice versa.
- Cleaner discovery in n8n's community-nodes directory (two focused entries beat one grab-bag).

What they *share* and how we reuse it: the BridgeManager singleton pattern (§6.3), the Method Guard + Rate Limit primitives from `UnoQTool` (§6.4 in the [n8n-nodes README](packages/n8n-nodes/README.md)). Those are architectural patterns, not imported code — we reimplement them in the new package (small files, zero coupling wins over DRY here).

### 13.3 SDK dependencies — two libraries, not one

This is the load-bearing choice. Arduino ships **two** official JS SDKs for Cloud access, and we need both:

- **[`@arduino/arduino-iot-client`](https://www.npmjs.com/package/@arduino/arduino-iot-client)** — REST client. OAuth2 client credentials against `api2.arduino.cc/iot`. Covers: Things, Properties (including `publish` to write values), Devices, Series (time-series analytics), Dashboards, Triggers (CRUD for Arduino Cloud's own alert triggers), OTA, Tags, Templates, NetworkCredentials. Rate limit: 10 req/s authenticated.
- **[`arduino-iot-js`](https://github.com/arduino/arduino-iot-js)** — **MQTT-over-WebSocket** client. `onPropertyValue(thingId, propertyName, cb)` subscribes to realtime updates from the Arduino Cloud broker using the *same* user OAuth2 credentials. This is the canonical third-party realtime path; it removes the need for polling or IFTTT-proxied webhooks that an earlier read of the docs wrongly concluded were necessary.

**Correction on record:** an earlier design draft assumed the Arduino Cloud MQTT broker was reserved for devices and that third-party subscription required either polling or Maker-plan webhooks. `arduino-iot-js` refutes that — it exists precisely to let user-credentialed clients subscribe. The realtime trigger uses it.

Auth flow for both SDKs: `POST https://api2.arduino.cc/iot/v1/clients/token` with `grant_type=client_credentials`, `client_id`, `client_secret`, `audience=https://api2.arduino.cc/iot`, optional `organization_id`. The credential class owns token caching + refresh (~30 s before expiry); both SDK instances consume the same cached token.

### 13.4 Node surface — v1 scope

**Two visible nodes + one credential.** Everything else is deferred until a real user asks; see §13.5 for what was explicitly cut and why.

| Node | Type | What it does |
|---|---|---|
| `ArduinoCloud` | Action (tool-usable) | v1 exposes only **Resource: Property** with operations **Get** (`PropertiesV2Show`), **Set** (`PropertiesV2Publish`), **GetHistory** (`SeriesV2HistoricData`). Marked `usableAsTool: true` — drops into Tools Agent's tool connector directly. Ships Property Guard + Rate Limit affordances for LLM safety (see below). Resource/Operation dropdowns are wired from day one so adding more resources later is non-breaking. |
| `ArduinoCloudTrigger` | Trigger | Realtime: fires on property update. Backed by `arduino-iot-js` MQTT-over-WebSocket. **MQTT mode only** in v1 — no polling, no webhook mode (both deferred, see §13.5). Thing/Property pickers are populated via `ThingsV2List` + `PropertiesV2List` during node configuration; no separate Thing or Device list action is needed in the palette. |

**Credential:** `arduinoCloudOAuth2Api` — Client ID, Client Secret, optional Organization ID. `Test Connection` runs a cheap REST call (e.g. `ThingsV2List` page 1 size 1). Token cache is a process-singleton keyed by credential ID, shared across both nodes and both SDKs.

**LLM tool-use affordances on `ArduinoCloud`** (the differentiated capability per the Value claim; these ship with v0.1.0, not deferred):

- **`usableAsTool: true`** — node appears in Tools Agent's tool connector without wrapping.
- **Property Guard** — user-editable JS predicate with `property`, `value`, `operation`, `budget` in scope. Returns `undefined`/`null` to allow, or a rejection string that is fed back to the LLM as the tool output so the agent self-corrects. Same ergonomics as `UnoQTool`'s Method Guard (see [packages/n8n-nodes/README.md#method-guard](packages/n8n-nodes/README.md#method-guard)).
- **Rate Limit** — Max Calls + window (per minute/hour/day), in-memory per process. Excess calls short-circuit with a "retry-in-Xs" message the LLM reads. Same primitive as `UnoQTool`.
- **Idempotency flag** on the `Set` operation — per-call toggle controlling whether a transient failure triggers a single replay within the remaining timeout budget. Defaults off for actuator-style properties, on for absolute-state writes.
- **Tool description discipline** — the node's `description` (what the LLM sees) starts with a verb, states units and ranges, includes an example invocation. 90% of agent-ergonomics bugs are prose, not code.

**Payload shape conventions:**

- **`Property.Set`** — accept an n8n expression as the value, coerce to the property's declared type server-side via the SDK, and reject type mismatches *before* the REST call so errors surface in the node's error output with a clear message, not as an opaque 400.
- **Location** variables — accept `{ lat, lon }` at the node boundary, convert to the SDK's shape internally.
- **Color** variables — accept `{ hue, sat, bri }`.
- **Time** variables — accept ISO-8601 or Unix timestamps, normalise before dispatch.

Rough effort estimate: **5–7 days of work total** — ~3–5 days for the action node + trigger as thin wrappers around the two Arduino SDKs (see §13.3), plus ~1–2 days to port the Method Guard and Rate Limit primitives from [packages/n8n-nodes/](packages/n8n-nodes/). Still consistent with a narrow-but-useful package, not a flagship product.

### 13.5 What was considered and rejected

**Cut from v1 during the 2026-04-24 rescope because the honest wedge analysis (§13.1) found no real audience to justify them:**

- **`ArduinoCloudOta` node.** The earlier scope framed OTA as a marquee differentiator. On inspection, nobody runs 20+ UNO Qs today, and generic Arduino fleet operators already use Arduino Cloud's own OTA UI. Revisit only if real multi-device deployments materialise.
- **`ArduinoCloudTool` as a separate node.** Rejected in favour of marking `ArduinoCloudProperty` itself `usableAsTool: true` and landing the Property Guard + Rate Limit affordances directly on the action node (see §13.4). This avoids palette duplication (action + tool variants of the same capability) and matches n8n's modern idiom for tool-capable actions. The LLM-safety primitives still ship — they live on `ArduinoCloudProperty`, not on a sibling node. `UnoQTool`'s separate-node split is a legacy shape in `n8n-nodes-uno-q` that we do not replicate here.
- **`ArduinoCloudTrigger` polling and webhook fallback modes.** MQTT-over-WS covers the trigger semantic for the audience who will actually use this package. Polling is wasteful against the 10 req/s REST budget; webhook mode solves "can't hold a WebSocket open," which is rare in self-hosted n8n. Both are trivially addable later if a user hits the edge case.
- **Admin-plane CRUD nodes and operations** (Thing, Device, Dashboard, Tag, Trigger-alerts). Users don't provision these from workflows; they use the Arduino Cloud web UI. Zero demand signal. The `ArduinoCloud` action node's Resource dropdown is wired so these can be added later without breaking changes; they are simply not present at v1.
- **`Device.GetEvents` / online-offline monitoring.** Users who care about uptime reach for UptimeKuma or dedicated monitoring, not n8n workflows. Real use case, adjacent product.
- **`Series.BatchQuery` / raw / last-value batch.** `GetHistory` (single-property, time-window) covers the common case; batch is analytics territory. Niche of a niche.

**Structural rejections (still valid, kept from earlier scoping):**

- **Custom bridge package `@raasimpact/arduino-cloud-bridge`.** Considered by analogy with `@raasimpact/arduino-uno-q-bridge`. Rejected: Arduino already publishes two maintained JS SDKs (`@arduino/arduino-iot-client` for REST, `arduino-iot-js` for MQTT-over-WS); reimplementing their wire protocol adds maintenance for no gain. The n8n package depends on the SDKs directly; the only wrapper we write is a thin `ArduinoCloudManager` singleton (token cache + MQTT connection + subscription refcount).
- **Extending the UnoQ `BridgeManager` to manage Cloud connections too.** Tempting for "one place to manage all transports" but the contracts are different (msgpack-rpc vs. HTTP+MQTT, socket vs. SDK object), coupling would leak across packages, and the two managers share no runtime state. Separate singletons, same pattern.
- **IFTTT/Zapier webhook bridge as the trigger source.** Would work but adds an external dependency and a second account per user. `arduino-iot-js` MQTT path is the direct, maintained alternative and is what `ArduinoCloudTrigger` uses.

### 13.6 Delivery plan

Three steps, v1.0 at the end — matches the narrow scope.

1. **Package scaffold + credential.** `packages/n8n-nodes-arduino-cloud/` under the monorepo. `arduinoCloudOAuth2Api` credential with Test Connection (`ThingsV2List` page 1 size 1). Token cache as a process-singleton keyed by credential ID. Unit tests mock the token endpoint. **Deliverable:** green CI, credential usable from a stock n8n HTTP Request node as an early smoke test.
2. **`ArduinoCloud` action node with Property resource, tool-usable.** Operations: **Get** (`PropertiesV2Show`), **Set** (`PropertiesV2Publish`), **GetHistory** (`SeriesV2HistoricData`). Thing/Property dropdowns populated via `ThingsV2List` + `PropertiesV2List`. Type coercion for Location (`{lat, lon}`) and Color (`{hue, sat, bri}`) compound variables at the node boundary. **`usableAsTool: true` plus Property Guard + Rate Limit affordances ported from [packages/n8n-nodes/](packages/n8n-nodes/) — these ship with v0.1.0, not deferred, because they are the differentiated capability per the Value claim.** Integration tests against a real Arduino Cloud sandbox account, gated on env vars analogous to `UNOQ_SOCKET` (e.g. `ARDUINO_CLOUD_CLIENT_ID` / `ARDUINO_CLOUD_CLIENT_SECRET`); an additional smoke test exercises the Tools Agent → `ArduinoCloud` tool-call path end-to-end with the Guard rejecting a synthetic bad write. **Deliverable:** `npm publish` v0.1.0 — an LLM can safely read, write, and query history on any Cloud-connected Arduino variable.
3. **`ArduinoCloudTrigger` with `arduino-iot-js` (MQTT-over-WS).** `ArduinoCloudManager` singleton holds one WebSocket per credential, refcounts subscriptions by `thingId/propertyName` — same architecture as [`BridgeManager`](packages/n8n-nodes/src/BridgeManager.ts). Reconnect loop owned by the manager (verify `arduino-iot-js`'s auto-resume behaviour during implementation; if flaky, the manager takes ownership). **Deliverable:** v1.0.0, realtime workflows usable.

Anything beyond step 3 is deferred until a specific user request (see §13.5 for the deferred list). Not on the roadmap, not in the README, not speculated about — the point of the rescope is to resist re-expanding the surface in the absence of signal.

**Docs:** top-level README gets a short "Two packages" section pointing users at the right one based on deployment shape. Each package keeps its own detailed README. The Cloud-package README leads with *"give your AI agent persistent memory of what your hardware did"* as the differentiating value, not *"integrate Arduino Cloud with n8n"* — the former is defensible positioning, the latter is a commodity integration.

### 13.7 Open items

- **`organization_id` placement.** Put it on the credential (one credential per org, clean) or per-node field (one credential, many orgs)? Default: credential. Revisit if users with multi-org access complain.
- **Rate limit 10 req/s enforcement.** Centralise in the manager (per-credential token-bucket) or rely on 429 retry? Central bucket is safer for bulk workflows; worth the extra code. Decide during step 2.
- **WebSocket drop handling.** `arduino-iot-js` behaviour on long disconnects, reconnect backoff, whether in-flight subscriptions auto-resume. Verify empirically during step 3; if auto-resume is shaky, the manager owns the reconnect loop.
- **Monorepo shape.** Two production packages (`bridge`, `n8n-nodes`) plus this makes three. Top-level scripts (§CLAUDE.md "Commands") already fan out across workspaces; confirm lint/test/build run cleanly on the new package without rewiring.

### 13.8 Related sections

- §6.3 — BridgeManager singleton. `ArduinoCloudManager` is architecturally identical: one process-wide instance per credential, refcounts subscriptions, stashed on `globalThis` under a `Symbol.for(...)` key to survive the esbuild-bundled-per-node-file model.
- §6.4 — Method Guard + Rate Limit on `UnoQTool`. `ArduinoCloudTool` reuses the same ergonomics (user-editable JS predicate + sliding-window limiter + `budget` in guard scope).
- §8 — Open items. §13.7 keeps Arduino-Cloud-specific opens local; §8 stays about UNO Q v1.
- §11 — Project-level decisions. Priority flip recorded there.
- §12 — Multi-Q. Paused for §13. Re-read §12 when resuming.