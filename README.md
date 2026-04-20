# n8n-uno-q

n8n community nodes for the [Arduino UNO Q](https://www.arduino.cc/), so that workflows in n8n can read sensors, drive GPIO, call I²C devices, and react to async events coming from the on-board microcontroller.

The repo ships two npm packages:

- **[`@raasimpact/arduino-uno-q-bridge`](packages/bridge/)** — a pure Node.js MessagePack-RPC client for `arduino-router` (the Go service that runs on the Q). Zero external dependencies except `@msgpack/msgpack`. Useful on its own for anyone writing Node.js code on a UNO Q — Express, Fastify, Bun, raw scripts.
- **[`n8n-nodes-uno-q`](packages/n8n-nodes/)** — an n8n community package that depends on the bridge and exposes four nodes: *Arduino UNO Q Call* (action), *Arduino UNO Q Trigger* (MCU → workflow events), *Arduino UNO Q Respond* (companion to Trigger's deferred-response mode), and *Arduino UNO Q Method* (callable by n8n's AI Agent, so an LLM can decide when to read a sensor or fire an actuator as part of reasoning).

---

## Production install — on the UNO Q

End-user flow, assuming a UNO Q out of the box (Docker preinstalled, `arduino-router` already running as a systemd service).

1. **SSH into the Q from your PC:**
   ```bash
   ssh arduino@<hostname-or-ip>
   ```
2. **Grab the compose file:**
   ```bash
   mkdir -p ~/n8n && cd ~/n8n
   curl -fsSL -O https://raw.githubusercontent.com/raasimpact/n8n-uno-q/main/deploy/docker-compose.yml
   ```
3. **Start n8n:**
   ```bash
   docker compose up -d
   ```
   The first run pulls the n8n image — expect several minutes over the Q's network before the container is up.
4. **Open n8n** in a browser on your PC: `http://<hostname-or-ip>:5678`. On first launch n8n redirects to `/setup` — create the owner account (email + password) right there.

   > The UNO Q boots n8n slowly — expect the page to throw connection errors for a minute or two after every `docker compose up`/`restart` while the container finishes initialising. Just reload. Hopefully much snappier on the upcoming VentUNO Q.
5. **Install the community node from the UI:** *Settings → Community Nodes → Install a community node* → type `n8n-nodes-uno-q` → Install. n8n pulls the package (and the bridge as a transitive dependency) from npm and persists it in the `n8n_data` volume.

Done. The *Arduino UNO Q Call*, *Arduino UNO Q Trigger*, *Arduino UNO Q Respond*, and *Arduino UNO Q Method* nodes are now available in the node picker (search "Arduino" or "UNO Q").

**Updates:**

- This package: click *Update* in the same Community Nodes page.
- n8n itself: `docker compose pull && docker compose up -d` on the Q.

### Advertised host for AI Chat and webhooks

The compose file defaults `N8N_HOST` / `WEBHOOK_URL` to `linucs.local`, which is the hostname of the Q used during development of this package. If your Q answers on a different hostname or an IP, override it before bringing n8n up — otherwise the built-in **AI Chat** panel (and any Webhook/Chat Trigger node) will advertise an unreachable URL to the browser and fail with *"Failed to receive response"* without running any nodes.

```bash
# Option A — shell env, one-off
N8N_HOST=myq.local WEBHOOK_URL=http://myq.local:5678/ docker compose up -d

# Option B — persist via .env next to docker-compose.yml
cat > .env <<EOF
N8N_HOST=myq.local
WEBHOOK_URL=http://myq.local:5678/
EOF
docker compose up -d
```

The hostname you set must be the one your **browser** uses to reach n8n — not the container's internal name.

---

## Development

For contributors and anyone modifying the packages. Requires Node ≥ 20 on your dev machine and a UNO Q reachable over SSH.

### First-time setup

```bash
git clone https://github.com/raasimpact/n8n-uno-q.git
cd n8n-uno-q
npm install
npm run build
```

### Dev loop

[`deploy/sync.sh`](deploy/sync.sh) builds, rsyncs `packages/*/dist` into `~/n8n/custom/` on the Q, and reloads n8n with a dev-only compose override that bind-mounts that folder. No image rebuild, no npm publish needed.

```bash
./deploy/sync.sh
```

Override the target host/dir via env vars (defaults shown):

```bash
UNOQ_HOST=arduino@linucs.local UNOQ_DIR=/home/arduino/n8n ./deploy/sync.sh
```

### Unit tests

```bash
npm run test              # everything
npm run test -w packages/bridge
npx vitest run packages/bridge/test/bridge.test.ts
```

### Integration tests (require the real UNO Q)

The bridge's integration suite is gated on `UNOQ_SOCKET` and skipped otherwise. Node never runs on the Q itself — tunnel the socket from your PC.

In a separate terminal, leave the tunnel running:

```bash
rm -f /tmp/arduino-router.sock
ssh -N -L /tmp/arduino-router.sock:/var/run/arduino-router.sock arduino@<your-q>
```

Then in your working terminal:

```bash
UNOQ_SOCKET=/tmp/arduino-router.sock npm run test:integration -w packages/bridge
```

Some tests in [packages/bridge/test/integration.test.ts](packages/bridge/test/integration.test.ts) additionally require the [sketches/integration-test.ino](sketches/integration-test.ino) firmware flashed on the board. The sketch depends on these Arduino libraries — install them via the IDE's Library Manager before flashing:

- **`Arduino_RouterBridge`** (by Arduino) — MsgPack-RPC bridge to `arduino-router`.
- **`Arduino_LED_Matrix`** (by Arduino) — drives the on-board 8×13 LED matrix.
- **`ArduinoJson`** (by Benoît Blanchon) — used by `printBridgeReply()` to render any RPC return type as JSON. Note: this is **not** the similarly named `Arduino_JSON` library.

---

## Repo layout

```
packages/bridge       → @raasimpact/arduino-uno-q-bridge (Node ↔ arduino-router)
packages/n8n-nodes    → n8n-nodes-uno-q (n8n community nodes)
deploy/               → docker-compose (prod base + dev override) and sync.sh
experiments/          → raw-socket smoke tests against a real Q
sketches/             → MCU firmware used by integration tests
```

---

## License

MIT.
