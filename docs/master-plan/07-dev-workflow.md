## 7. Dev workflow architecture: decisions

> Procedures, commands, testing layers, and triage live in [CLAUDE.md](CLAUDE.md). This section captures only the *decisions* behind them, so they aren't repeatedly re-questioned.

### Monorepo on npm workspaces

Single git repo with `packages/bridge` and `packages/n8n-nodes`, managed by npm workspaces. Settled on npm (not pnpm) because the n8n community nodes tooling is friendlier to plain `npm`. Split into separate repos later if the bridge package gets independent uptake.

### Source of truth lives on PC

App Lab is a **remote editor**: source code lives on the UNO Q, not on the PC. A firmware update **wipes all user apps** — including any App Lab-hosted sketch. → Git on the PC is the source of truth, always. Treat the MCU sketch the same way: commit it to [sketches/](sketches/) even though App Lab can edit it in place.

### Node never runs directly on the UNO Q

Node.js is not installed on the Q outside of containers. All Node-based testing happens either via an SSH-tunneled Unix socket (bridge unit/integration tests from the PC) or inside the n8n container on the Q (n8n-node testing). Never reference `/var/run/arduino-router.sock` as a path in PC-side commands — that path only exists on the Q and inside containers with the socket bind-mounted. Tunnel it and use `/tmp/arduino-router.sock`.

### How n8n sees our packages — Pattern A (dev) and Pattern C (prod)

n8n loads community nodes from `/home/node/.n8n/custom/`. Any npm package in there whose `package.json` declares an `"n8n"` entry point is discovered at startup. We use two patterns:

**Pattern A — bind-mount for dev loop.** [deploy/sync.sh](deploy/sync.sh) builds locally, rsyncs `packages/*/dist` to `custom/packages/*/` on the Q, and restarts n8n with a dev-only compose override that bind-mounts that folder. No image rebuild, no `npm publish`. `sync.sh` wipes `custom/packages` before each sync so stale files from earlier layouts don't get picked up by n8n's recursive `.node.js` scan.

**Pattern C — GUI install from inside n8n (production).** Settings → Community Nodes → Install `n8n-nodes-uno-q`. n8n pulls it from npm with the bridge as a transitive dependency and persists it in the `n8n_data` volume. Updates are one click. This is the shipping story: a user who grabs `deploy/docker-compose.yml` runs `docker compose up -d` and installs the node from the UI. No build on the Q, no cross-arch image rebuild, no bind-mount.

**Why not a custom Docker image (Pattern B)?** Earlier drafts had a Dockerfile that baked `npm install -g n8n-nodes-uno-q` on top of `n8nio/n8n:latest`. Rejected: building that image on a Mac for the UNO Q's arch requires either buildx cross-compilation or building on the Q itself — both fragile, both avoidable once the package is on npm and Pattern C exists.

**Implementation consequence:** because each `*.node.js` ends up a self-contained CJS bundle with its own copy of shared modules (esbuild inlines everything except the n8n-runtime externals), `BridgeManager.getInstance()` must stash the singleton on `globalThis` under a `Symbol.for(...)` key — otherwise each node would see its own `BridgeManager` and the refcount invariant would break. Mechanics in [CLAUDE.md § Dev loop](CLAUDE.md).
