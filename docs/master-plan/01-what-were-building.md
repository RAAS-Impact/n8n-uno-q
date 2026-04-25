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
