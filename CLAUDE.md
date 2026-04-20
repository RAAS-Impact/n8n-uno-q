# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read this first

**[CONTEXT.md](CONTEXT.md) is the master plan and source of truth.** Read it in full before any other action. It covers: what we're building, the architectural decision to talk directly to `arduino-router` (no Python proxy), verified facts about the target UNO Q hardware, the MessagePack-RPC protocol, the design of both npm packages, open risks, and the rationale behind every decision. When a decision here or in code contradicts CONTEXT.md, update CONTEXT.md in the same commit.

This file covers the *how*: commands, procedures, conventions. For the *why* behind any operational choice (Pattern A bind-mount vs rejected alternatives, source-of-truth-on-PC, etc.), cross-reference [CONTEXT.md §7](CONTEXT.md).

## Repo shape

npm workspaces monorepo (Node ≥ 20, ESM, TypeScript). Two packages published independently:

- [packages/bridge](packages/bridge/) — `@raasimpact/arduino-uno-q-bridge`, a pure Node.js MessagePack-RPC client for the UNO Q router. No n8n dependency.
- [packages/n8n-nodes](packages/n8n-nodes/) — `n8n-nodes-uno-q`, community nodes (`UnoQCall`, `UnoQTrigger`, `UnoQRespond`, `UnoQTool`) that depend on the bridge package via workspace link.

The n8n nodes share a process-singleton [BridgeManager](packages/n8n-nodes/src/BridgeManager.ts) that refcounts `$/register` subscriptions — this is load-bearing (see CONTEXT.md §6 "singleton client"). Do not bypass it.

Supporting dirs: [experiments/](experiments/) (raw-socket smoke tests), [sketches/](sketches/) (MCU firmware used by integration tests), [deploy/](deploy/) (docker-compose + sync script for the UNO Q).

## Style conventions

- **Language:** TypeScript. Source in `src/`, build to `dist/`.
- **Tests:** Vitest. Smoke coverage before each publish.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`).
- **Style:** ESLint + Prettier with defaults, no bikeshedding.
- **Don't install globally** — adapt to available tools (`npx`, workspace scripts).

## Commands

Run from repo root (they fan out across workspaces):

```bash
npm run build          # tsc in every package
npm run test           # vitest run in every package (unit only)
npm run lint           # eslint .
npm run format         # prettier --write .
```

Per-package:

```bash
npm run build -w packages/bridge
npm run test  -w packages/bridge
npm run test:watch -w packages/bridge
```

Run a single test file or name:

```bash
npx vitest run packages/bridge/test/bridge.test.ts
npx vitest run -t "callWithTimeout"
```

## Dev loop (edit on PC, test on the Q)

Node never runs directly on the Q (see [CONTEXT.md §7](CONTEXT.md) for why). Every change goes through a build+sync step:

1. Edit code on PC.
2. `npm run build` locally — catches type errors fast.
3. `./deploy/sync.sh` builds, rsyncs `packages/*/dist` into `~/n8n/custom/` on the Q, and reloads n8n via a bind-mount override. No image rebuild, no `npm publish`.
4. Browser to `http://<uno-q-hostname>:5678`, test the workflow.
5. MCU sketch changes: edit in App Lab (or via arduino-cli), redeploy separately — the sketch is independent of the n8n container.

Override the target via env vars (defaults shown):

```bash
UNOQ_HOST=arduino@linucs.local UNOQ_DIR=/home/arduino/n8n ./deploy/sync.sh
```

**How the bundle reaches n8n.** [packages/n8n-nodes/scripts/build.mjs](packages/n8n-nodes/scripts/build.mjs) uses esbuild to compile each `*.node.ts` into a standalone CJS file with the bridge + msgpack inlined. `n8n-workflow` is the only external (provided by the n8n runtime). Because each node bundle has its own copy of `BridgeManager`, `BridgeManager.getInstance()` stashes the real singleton on `globalThis` under a `Symbol.for(...)` key. `tsc --noEmit` is used for type-checking only; esbuild owns the emit. Removing `"type": "module"` from [packages/n8n-nodes/package.json](packages/n8n-nodes/package.json) is what makes Node treat the bundled `.js` as CJS.

## Testing layers

When something stops working, walk from the lowest layer up; the first layer that fails is where the bug lives.

**Layer 0 — MCU sketch.** Add `Serial.println()` traces inside your bridged functions and watch them from App Lab's serial console, or `arduino-cli monitor` on a side terminal. Don't monitor `/dev/ttyHS1` — that's the router's exclusive channel. Route debug output on a different UART if you need it.

**Layer 1 — router reachable.** [experiments/test-router.mjs](experiments/test-router.mjs) is the canary. If it no longer prints `[1, 1, null, '<version>']`, the problem is lower than your code: router crashed, socket permissions changed, container can't reach the socket. Check with `ssh arduino@linucs "sudo systemctl status arduino-router"` and `ls -la /var/run/arduino-router.sock`.

**Layer 2 — bridge package.** Two tiers:

- **Unit** (fast, CI-friendly): mock transport, no real socket. Tests msgid allocation, timeout handling, reconnect backoff, error propagation. `npm run test -w packages/bridge`.
- **Integration** (manual, against the real Q): `npm run test:integration -w packages/bridge`. Covers register/call/notify round-trips, socket disconnect behaviour, multiple concurrent calls. Requires the SSH tunnel described in "Integration tests" below.

**Layer 3 — n8n nodes on PC (no Q in the loop).** You don't need to deploy to the Q to debug node UI, schema validation, or trigger refcounting. Run n8n locally pointing at a mock:

```bash
npm run build -w packages/n8n-nodes
N8N_CUSTOM_EXTENSIONS=/abs/path/to/packages/n8n-nodes/dist npx n8n start
```

The socket isn't available on the PC. Two options:

- **SSH tunnel the socket:** `rm -f /tmp/arduino-router.sock && ssh -N -L /tmp/arduino-router.sock:/var/run/arduino-router.sock arduino@linucs.local &`, then configure the node to use `/tmp/arduino-router.sock`. Higher latency but end-to-end realism.
- **Local mock router:** a ~50-line Node.js script that speaks msgpack-rpc and returns canned responses. Faster iteration, no Q required. Worth writing once and committing under [experiments/mock-router.mjs](experiments/).

**Layer 4 — n8n in the container on the Q.** Only after layer 3 is clean. Bugs here are typically bind-mount paths, permissions, env vars.

```bash
ssh arduino@linucs 'docker compose -f ~/n8n/docker-compose.yml logs -f n8n'
# Inspect inside the container:
ssh arduino@linucs 'docker compose -f ~/n8n/docker-compose.yml exec n8n ls /home/node/.n8n/custom'
```

**Layer 5 — Tools Agent with a real LLM.** Last layer because it's non-deterministic and costs tokens.

- Use a local LLM via Ollama for the dev loop — free, offline, fine for testing tool-calling behaviour. Reserve paid models for final polish.
- Enable `Return Intermediate Steps` on the agent node to see the reasoning trace — most bugs here are "the LLM didn't know when to call the tool" and the fix is in the tool description, not the code.
- When the LLM picks wrong tools or wrong params, rewrite the description before touching the code. 90% of agent debugging is prose.

## Integration tests (require the real UNO Q)

The bridge's integration suite is gated on the `UNOQ_SOCKET` env var and skipped otherwise. Node never runs on the Q — use an SSH tunnel from the PC:

In a **separate terminal**, open the tunnel and leave it running:

```bash
rm -f /tmp/arduino-router.sock
ssh -N -L /tmp/arduino-router.sock:/var/run/arduino-router.sock arduino@linucs.local
```

Then, in your working terminal, run the integration suite:

```bash
UNOQ_SOCKET=/tmp/arduino-router.sock npm run test:integration -w packages/bridge
```

Stop the tunnel with Ctrl-C in the first terminal when done.

The MCU-dependent tests in [integration.test.ts](packages/bridge/test/integration.test.ts) additionally require [sketches/integration-test.ino](sketches/integration-test.ino) to be flashed on the board.

Never reference `/var/run/arduino-router.sock` from PC-side commands — that path only exists on the Q (and inside containers with the socket bind-mounted).

## First-time install on the UNO Q

App Lab is not involved — n8n runs as a plain Docker service, managed by `docker compose` from the board's shell. Docker is pre-installed on the Q; the `arduino` user is in the `docker` group (the Docker socket shows `srw-rw---- docker`), so `sudo` is unnecessary.

```bash
ssh arduino@<q-hostname>
mkdir -p ~/n8n && cd ~/n8n
# Place docker-compose.yml here — either copy deploy/docker-compose.yml
# from the repo or curl it from GitHub (see top-level README).
docker compose up -d
# n8n is now on http://<q-hostname>:5678 — first load redirects to /setup
# to create the owner account.
```

Once bootstrapped, further changes flow through `./deploy/sync.sh`.

## docker-compose setup

Two layered files:

- [deploy/docker-compose.yml](deploy/docker-compose.yml) — prod base. Bind-mounts the router socket, persists an `n8n_data` volume, sets `N8N_COMMUNITY_PACKAGES_ENABLED`, `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE` (mandatory for UnoQTool), and the chat-webhook env (`N8N_HOST` / `WEBHOOK_URL`, overridable via shell or `.env`).
- [deploy/docker-compose.dev.yml](deploy/docker-compose.dev.yml) — dev override. Adds a bind-mount of `./custom` → `/home/node/.n8n/custom:ro` for Pattern A (bind-mount dev).

`sync.sh` applies both automatically when it runs; prod usage is plain `docker compose up -d` with only the base file.

**Gotcha:** without the `n8n_data` volume, every restart wipes workflows *and* the community nodes installed from the UI.

## Deploy to the UNO Q

[deploy/sync.sh](deploy/sync.sh) builds locally, rsyncs `packages/*/dist` into `deploy/custom/` on the Q, and restarts the n8n container. Overridable via `UNOQ_HOST` / `UNOQ_DIR`. This is Pattern A from [CONTEXT.md §7](CONTEXT.md) — bind-mount for dev loop, no image rebuild.

## Troubleshooting cheat sheet

| Symptom | First check |
|---|---|
| Nodes don't appear in n8n UI | Layer 4: is `./custom` bind-mounted and does `ls` show your package? Is the `"n8n"` entry point declared in `package.json`? |
| "Cannot connect to socket" | Layer 1: is the socket there and `rw` for all? Layer 4: is it bind-mounted into the container? |
| Call returns "method not available" | Layer 0: is the sketch actually running and has the MCU rebooted since you last changed `Bridge.provide(...)`? |
| Trigger fires twice for one MCU event | Layer 3: singleton refcount bug — two trigger nodes registered the same method. |
| Agent ignores tools that should obviously apply | Layer 5: rewrite the tool description in active voice, start with a verb, include an example. |
| Chat fails with "Failed to receive response" | `N8N_HOST` / `WEBHOOK_URL` default to an unreachable hostname. Set them to the hostname the browser uses to reach n8n. See top-level [README](README.md) "Advertised host for AI Chat and webhooks". |
| Tool node errors "has supplyData but no execute" | Community nodes can't use the `supplyData`/`ai_tool` pattern — only `@n8n/nodes-langchain` can. Use `usableAsTool: true` + `execute()` instead. See CONTEXT.md §6.4. |
| Actuator fires twice for one invocation (bridge over-retries) | The method is flagged `idempotent: true` but isn't — end-state differs on a replay. Flip it off on the Method or UnoQCall node. See [bridge README — Retry and idempotency](packages/bridge/README.md#retry-and-idempotency). |
| LLM re-invokes the tool after a failure (LLM over-retries) | The agent, not the bridge, is retrying. Say so in the tool description ("if this errors, state is unknown — do not retry without checking") and enable human-in-the-loop on the agent's tool connector. |
| Actuator silently skipped after a socket blip (bridge under-retries) | Method is genuinely idempotent (absolute write, pure read) but flagged `idempotent: false`. Flip it on so `callWithOptions` replays once within the remaining timeout budget. |
| LLM keeps proposing destructive or out-of-range values | Add a **Method Guard** on the Method node — a small JS predicate with `method`/`params` in scope that returns a rejection string for disallowed invocations (bad inputs, wrong time of day, external-state gating). The string is fed back to the agent as tool output, so the LLM self-corrects. See [packages/n8n-nodes/README.md#method-guard](packages/n8n-nodes/README.md#method-guard). |
