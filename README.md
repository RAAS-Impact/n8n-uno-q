# n8n-uno-q

n8n community nodes for the [Arduino UNO Q](https://store.arduino.cc/products/uno-q) and for [Arduino Cloud](https://cloud.arduino.cc), so that workflows in n8n can read sensors, drive GPIO, call I²C devices, react to async events coming from the on-board microcontroller, and — for any Arduino Cloud-connected board, not just the UNO Q — read and write Thing Properties and fire on realtime property updates.

The repo ships three npm packages:

- **[`@raasimpact/arduino-uno-q-bridge`](packages/bridge/)** — a pure Node.js MessagePack-RPC client for `arduino-router` (the Go service that runs on the Q). Zero external dependencies except `@msgpack/msgpack`. Useful on its own for anyone writing Node.js code on a UNO Q — Express, Fastify, Bun, raw scripts.
- **[`n8n-nodes-uno-q`](packages/n8n-nodes/)** — an n8n community package that depends on the bridge and exposes four nodes: *Arduino UNO Q Call* (action), *Arduino UNO Q Trigger* (MCU → workflow events), *Arduino UNO Q Respond* (companion to Trigger's deferred-response mode), and *Arduino UNO Q Method* (callable by n8n's AI Agent, so an LLM can decide when to read a sensor or fire an actuator as part of reasoning).
- **[`n8n-nodes-arduino-cloud`](packages/n8n-nodes-arduino-cloud/)** — an n8n community package for the hosted Arduino Cloud story, independent of the UNO Q. Exposes two nodes: *Arduino Cloud* (action, `usableAsTool`) with Property Get / Set / GetHistory plus *Property Guard* + *Rate Limit* safety rails for AI agents, and *Arduino Cloud Trigger* (realtime MQTT-over-WSS subscription to property updates). Works with every Arduino Cloud-supported board (Nano 33 IoT, MKR WiFi 1010, Portenta, UNO R4 WiFi, Nano ESP32, …), not just the UNO Q. Built on the two official Arduino JS SDKs — no bespoke wire protocol.

n8n can talk to a Q **locally** (same host, unix socket) or **remotely over TCP** via a relay container. Two relay flavours ship with this repo: a plain `socat` bridge for trusted LANs (`deploy/relay/`), and a `stunnel` bridge with mutual TLS for untrusted networks (`deploy/relay-mtls/`), with a beginner-friendly PKI wrapper under [`deploy/relay-mtls/pki/`](deploy/relay-mtls/pki/) that issues the certificates for you. All three shapes share the same nodes and the same `Arduino UNO Q Router` credential type — the transport field and the optional *Use TLS* toggle pick which one.

For AI-agent workflows touching actuators, read the bridge's [Retry and idempotency](packages/bridge/README.md#retry-and-idempotency) section before wiring up a Method node. The `idempotent` checkbox decides whether the bridge auto-retries a mid-call socket drop (keeps relays from firing twice), the optional **Method Guard** lets you reject calls at the gate — by parameter value, time of day, or any other predicate — before they reach the MCU, and the optional **Rate Limit** caps how often the LLM may invoke the tool (minute/hour/day) to protect a constrained device from eager agents.

---

## Install n8n on the UNO Q (same-host)

End-user flow, assuming a UNO Q out of the box (Docker preinstalled, `arduino-router` already running as a systemd service).

1. **SSH into the Q from your PC:**
   ```bash
   ssh arduino@<hostname-or-ip>
   ```
2. **Grab the compose file:**
   ```bash
   mkdir -p ~/n8n && cd ~/n8n
   curl -fsSL -O https://raw.githubusercontent.com/raas-impact/n8n-uno-q/main/deploy/n8n/docker-compose.yml
   ```
3. **Start n8n:**
   ```bash
   docker compose up -d
   ```
   The first run pulls the n8n image — expect several minutes over the Q's network before the container is up.
4. **Open n8n** in a browser on your PC: `http://<hostname-or-ip>:5678`. On first launch n8n redirects to `/setup` — create the owner account (email + password) right there.

   > The UNO Q boots n8n slowly — expect the page to throw connection errors for a minute or two after every `docker compose up`/`restart` while the container finishes initialising. Just reload.
5. **Install the community node from the UI:** *Settings → Community Nodes → Install a community node* → type `n8n-nodes-uno-q` → Install. n8n pulls the package (and the bridge as a transitive dependency) from npm and persists it in the `n8n_data` volume.
6. **Create an `Arduino UNO Q Router` credential:** *Settings → Credentials → New → Arduino UNO Q Router*. Leave *Transport* set to **Unix Socket (local)** and keep the default `/var/run/arduino-router.sock`. *Test Connection* should return `Connected — arduino-router <version>`.

Done. The *Arduino UNO Q Call*, *Arduino UNO Q Trigger*, *Arduino UNO Q Respond*, and *Arduino UNO Q Method* nodes are now available in the node picker (search "Arduino" or "UNO Q"). Each node has a **Credential** field — assign the one you just created.

**Updates:**

- This package: click *Update* in the same Community Nodes page.
- n8n itself: `docker compose pull && docker compose up -d` on the Q.

---

## Run n8n on a different machine (remote over TCP)

When n8n runs on your laptop, home server, or any box that isn't the Q, the `arduino-router` unix socket isn't reachable. A relay container on the Q bridges the gap: it mounts the router socket and exposes it as a TCP endpoint n8n can connect to.

**Pick one of two flavours** depending on how much you trust the network between n8n and the Q:

| Variant | When | Auth + encryption |
|---|---|---|
| [**A — plain socat**](deploy/relay/) | Trusted LAN. Home WiFi behind a router you control. | None — wire-level plaintext. |
| [**C — stunnel + mTLS**](deploy/relay-mtls/) | Anything else: untrusted WiFi, mixed-tenant networks, internet path. | Mutual TLS. The relay only accepts clients presenting a certificate signed by your local CA. |

Each has its own README with install / uninstall commands; quick pointers follow.

### Variant A — plain socat (trusted LAN)

Two paths depending on whether you've cloned this repo:

**Cloned repo (recommended if you're already developing against it):**

```bash
./deploy/relay/install.sh --host arduino@<q-hostname>
```

(Or set `UNOQ_HOST=arduino@<q-hostname>` once in your environment and call `./deploy/relay/install.sh` without the flag.)

The installer rsyncs the three files to the Q, runs `docker compose up -d`, and prints verification commands. See [`deploy/relay/README.md`](deploy/relay/README.md) for env-var overrides and the uninstall.

**Zero-clone (just curl the three files):**

```bash
ssh arduino@<q-hostname>
mkdir -p ~/relay && cd ~/relay
curl -fsSL -O https://raw.githubusercontent.com/raas-impact/n8n-uno-q/main/deploy/relay/q/docker-compose.yml
curl -fsSL -O https://raw.githubusercontent.com/raas-impact/n8n-uno-q/main/deploy/relay/q/Dockerfile
curl -fsSL -O https://raw.githubusercontent.com/raas-impact/n8n-uno-q/main/deploy/relay/q/entrypoint.sh
chmod +x entrypoint.sh
docker compose up -d
```

The relay listens on TCP port `5775` bound to `0.0.0.0` by default. Override via env:

- `UNOQ_RELAY_BIND=127.0.0.1` — loopback only; consume via an SSH reverse tunnel.
- `UNOQ_RELAY_BIND=192.168.1.42` — bind to a specific NIC.
- `UNOQ_RELAY_PORT=6000` — pick a different port.

### Variant C — stunnel + mTLS (untrusted network)

mTLS-authenticated; every client presents a certificate the relay checks against your CA. Requires the repo cloned locally for the PKI wrapper.

```bash
# One time: create a home CA.
./deploy/relay-mtls/pki/pki setup

# Per Q: issue a server cert.
./deploy/relay-mtls/pki/pki add device kitchen

# Per n8n instance: issue a client cert.
./deploy/relay-mtls/pki/pki add n8n laptop

# Deploy the relay + device cert to the Q.
./deploy/relay-mtls/install.sh --device kitchen --host arduino@<q-hostname>
```

The [PKI README](deploy/relay-mtls/pki/README.md) walks through every step, including hostname/IP options, troubleshooting, and when to consider `step-ca` for larger fleets. The [relay-mtls README](deploy/relay-mtls/README.md) covers install/uninstall details and common failure modes.

### In n8n

Create an `Arduino UNO Q Router` credential with *Transport* = **TCP**, *Host* = the Q's hostname or IP, *Port* = `5775`.

- For **Variant A**: leave *Use TLS (mTLS)* off. *Test Connection* should report the router version.
- For **Variant C**: toggle *Use TLS (mTLS)* on, paste the contents of `deploy/relay-mtls/pki/out/n8n/<nick>/ca.pem`, `client.pem`, `client.key` into the three PEM fields. *Test Connection* runs the full TLS handshake plus `$/version`.

From then on the nodes behave exactly like in the same-host setup — just assign the credential.

---

## Multiple Qs

Define one credential per Q (`Kitchen Q`, `Garage Q`, …) and assign a different one to each node in a workflow. A workflow that reads a temperature sensor on the kitchen Q and fires a fan relay on the garage Q is two nodes, one credential each — no other coordination needed.

Credentials can mix freely: one unix-socket credential for a local Q and several TCP credentials for remote Qs in the same workflow.

---

## Advertised host for AI Chat and webhooks

The [sample compose file](deploy/n8n/docker-compose.yml) defaults `N8N_HOST` / `WEBHOOK_URL` to `linucs.local`, the hostname used during development of this package. If your Q answers on a different hostname or an IP, override it before bringing n8n up — otherwise the built-in **AI Chat** panel (and any Webhook/Chat Trigger node) will advertise an unreachable URL to the browser and fail with *"Failed to receive response"* without running any nodes.

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
git clone https://github.com/raas-impact/n8n-uno-q.git
cd n8n-uno-q
npm install
npm run build
```

### Dev loop

[`deploy/sync.sh`](deploy/sync.sh) builds, rsyncs `packages/*/dist` into `~/n8n/custom/packages/` on the Q, and reloads n8n with a dev-only compose override that bind-mounts that folder. No image rebuild, no `npm publish` needed.

```bash
./deploy/sync.sh
```

Override the target via env vars (defaults shown):

```bash
UNOQ_HOST=arduino@linucs.local UNOQ_BASE=/home/arduino ./deploy/sync.sh
```

### Unit tests

```bash
npm run test              # everything
npm run test -w packages/bridge
npx vitest run packages/bridge/test/bridge.test.ts
```

### Integration tests (require the real UNO Q)

The bridge's integration suite runs once per transport configured via env vars; any combination of `UNOQ_SOCKET`, `UNOQ_TCP_HOST`+`UNOQ_TCP_PORT`, and `UNOQ_TLS_*` can be set in one command to exercise all three in one run. The suite is skipped when none are set. Node never runs on the Q itself — tunnel from your PC.

**Unix-socket path** — in a separate terminal, leave the tunnel running:

```bash
rm -f /tmp/arduino-router.sock
ssh -N -L /tmp/arduino-router.sock:/var/run/arduino-router.sock arduino@<your-q>
```

Then in your working terminal:

```bash
UNOQ_SOCKET=/tmp/arduino-router.sock npm run test:integration -w packages/bridge
```

**TCP path** (Variant A relay running on the Q) — forward the TCP port instead:

```bash
ssh -N -L 5775:localhost:5775 arduino@<your-q>
```

Then:

```bash
UNOQ_TCP_HOST=127.0.0.1 UNOQ_TCP_PORT=5775 npm run test:integration -w packages/bridge
```

**TLS path** (Variant C relay running on the Q) — no tunnel, n8n connects directly. `UNOQ_TLS_HOST` must match what the server cert was issued for (usually `<q-hostname>.local`; loopback won't work unless the cert's SAN covers `127.0.0.1`):

```bash
UNOQ_TLS_HOST=<q-hostname>.local UNOQ_TLS_PORT=5775 \
UNOQ_TLS_CA=deploy/relay-mtls/pki/out/n8n/<nick>/ca.pem \
UNOQ_TLS_CERT=deploy/relay-mtls/pki/out/n8n/<nick>/client.pem \
UNOQ_TLS_KEY=deploy/relay-mtls/pki/out/n8n/<nick>/client.key \
npm run test:integration -w packages/bridge
```

Some tests in [packages/bridge/test/integration.test.ts](packages/bridge/test/integration.test.ts) additionally require the [sketches/integration-test.ino](sketches/integration-test.ino) firmware flashed on the board. The sketch depends on these Arduino libraries — install them via the IDE's Library Manager before flashing:

- **`Arduino_RouterBridge`** (by Arduino) — MsgPack-RPC bridge to `arduino-router`.
- **`Arduino_LED_Matrix`** (by Arduino) — drives the on-board 8×13 LED matrix.
- **`ArduinoJson`** (by Benoît Blanchon) — used by `printBridgeReply()` to render any RPC return type as JSON. Note: this is **not** the similarly named `Arduino_JSON` library.

---

## Repo layout

```
packages/bridge                 → @raasimpact/arduino-uno-q-bridge (Node ↔ arduino-router)
packages/n8n-nodes              → n8n-nodes-uno-q (UNO Q community nodes)
packages/n8n-nodes-arduino-cloud → n8n-nodes-arduino-cloud (Arduino Cloud community nodes)
deploy/n8n/                     → docker-compose (prod base + dev override) for n8n on the Q
deploy/relay/                   → Variant A: plain socat TCP-to-unix-socket relay
  q/                            →   container assets shipped to the Q (Dockerfile, compose, entrypoint)
deploy/relay-mtls/              → Variant C: stunnel + mTLS relay
  q/                            →   container assets shipped to the Q (Dockerfile, compose, stunnel.conf, certs/)
  pki/                          →   openssl wrapper that issues the mTLS certs (PC-only)
deploy/lib/                     → shared install-script helpers (SSH multiplexing)
deploy/sync.sh                  → build + rsync + reload helper for the n8n custom-nodes bundle
experiments/                    → raw-socket smoke tests against a real Q
sketches/                       → MCU firmware used by integration tests
```

---

## License

MIT.
