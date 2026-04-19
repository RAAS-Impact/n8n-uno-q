# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read this first

**[CONTEXT.md](CONTEXT.md) is the master plan and source of truth.** Read it in full before any other action. It covers: what we're building, the architectural decision to talk directly to `arduino-router` (no Python proxy), verified facts about the target UNO Q hardware, the MessagePack-RPC protocol, the design of both npm packages, the dev/deploy workflow, the layered debug flow, and open risks. When a decision here or in code contradicts CONTEXT.md, update CONTEXT.md in the same commit.

## Repo shape

npm workspaces monorepo (Node ≥ 20, ESM, TypeScript). Two packages published independently:

- [packages/bridge](packages/bridge/) — `@raasimpact/arduino-uno-q-bridge`, a pure Node.js MessagePack-RPC client for the UNO Q router. No n8n dependency.
- [packages/n8n-nodes](packages/n8n-nodes/) — `n8n-nodes-uno-q`, community nodes (`UnoQCall`, `UnoQTrigger`, `UnoQRespond`, `UnoQTool`) that depend on the bridge package via workspace link.

The n8n nodes share a process-singleton [BridgeManager](packages/n8n-nodes/src/BridgeManager.ts) that refcounts `$/register` subscriptions — this is load-bearing (see CONTEXT.md §6 "singleton client"). Do not bypass it.

Supporting dirs: [experiments/](experiments/) (raw-socket smoke tests), [sketches/](sketches/) (MCU firmware used by integration tests), [deploy/](deploy/) (docker-compose + sync script for the UNO Q).

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

## Deploy to the UNO Q

[deploy/sync.sh](deploy/sync.sh) builds locally, rsyncs `packages/*/dist` into `deploy/custom/` on the Q, and restarts the n8n container. Overridable via `UNOQ_HOST` / `UNOQ_DIR`. This is Pattern A from CONTEXT.md §7 — bind-mount for dev loop, no image rebuild.

## Conventions

- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`).
- MIT license, semver starts at 0.1.0.
- Don't install globally — adapt to tools already available (`npx`, workspace scripts).
