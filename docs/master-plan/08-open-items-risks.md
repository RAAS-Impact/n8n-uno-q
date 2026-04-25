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
