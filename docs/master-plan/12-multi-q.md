## 12. Multi-Q support

**Status (2026-04-23):** Variants A and C implemented on `feat/multi-q` and verified against real hardware (mTLS handshake + msgpack-rpc round-trip green over `linucs.local:5775`). Variant B (Tailscale) deferred as future work — see §11 priority update. This section remains the authoritative spec for the whole multi-Q story; pick it up here regardless of which variant you're extending.

### 12.1 Motivation

Today a single n8n instance talks to a single UNO Q via the local unix socket, same host. The multi-Q story covers three scenarios, all served by Variant A (steps 1–3):

1. **Remote single-Q access.** n8n running on any separate machine (server, home PC, cloud VM) needs to reach a UNO Q over the network. This is a first-class use case, not a dev convenience: anyone who already has an n8n instance and adds a UNO Q, or who prefers not to run n8n on the board itself, hits this immediately. Current workaround is an SSH-tunneled unix socket (§9, CLAUDE.md); fine for occasional tests, not viable for continuous use.
2. **Multi-board orchestration.** A single n8n instance drives multiple UNO Qs, each addressed by its own credential. One workflow reads a sensor from Q-A and actuates a motor on Q-B, selected by hostname. Does not require the Ventuno Q — any machine running n8n can act as orchestrator.
3. **Ventuno Q as dedicated orchestrator.** The anticipated Ventuno Q (more powerful than the UNO Q) runs n8n and drives satellite UNO Qs over the LAN. Scenario 2 at a dedicated node, rather than a developer's PC.

Neither scenario is supported by today's single-socket-same-host design.

### 12.2 Architecture: WireGuard-mesh overlay + relay container

**Status (2026-04-23):** the section below is the original design contemplating a WireGuard overlay (Variant B / Tailscale) as the production transport. What actually shipped is Variant A (trusted LAN, no overlay) plus Variant C (mTLS over plain TCP, no overlay). The overlay narrative here is preserved because it's the natural path if Variant B is ever revisited — §12.5.2 holds the deferred implementation spec, and §12.2.2 the overlay-choice analysis.

The identity + transport layer *would be* a **WireGuard-based mesh overlay**, with **Tailscale as the default implementation** — a deployment choice, not a lock-in. See §12.2.2 for alternatives we evaluated and their swap-out cost, and §12.5.2's "Swapping the overlay" for the mechanics. The rest of this section describes that default; anywhere the text says "Tailscale" or "`tailscaled`", read that as "the mesh-overlay client of your choice."

Three pieces, landing together:

1. **Bridge HAL refactor** — `Transport` interface in `packages/bridge/` with `UnixSocketTransport` (existing behaviour) and `TcpTransport` (new). Chosen automatically based on config shape. See §12.3.
2. **`UnoQRouterApi` credentials in n8n** — each Q is a named n8n credential (transport + path *or* host+port). Nodes reference it by ID. Credential's Test Connection button runs a `$/version` round-trip. See §12.4.
3. **Relay container** — a plain Docker service the user installs on each satellite Q via docker-compose. Bundles a TCP-to-unix-socket proxy (`socat`) and, in the production variant, `tailscaled` on top. Mounts `/var/run/arduino-router.sock` in, exposes the in-container loopback TCP port, and (with Tailscale) publishes it to the owner's tailnet via `tailscale serve`. See §12.5. **This is not an App Lab "Brick"** in the Arduino sense — it's a manual containerised deployment. See §12.5.3 for notes on possible future Brick packaging.

**Network flow:**

```
[n8n host (PC or Ventuno Q)]                       [UNO Q satellite]
  n8n                                                 arduino-router
    │                                                       ▲
    │ msgpack-rpc over TCP                                  │ unix socket (/var/run/arduino-router.sock)
    ▼                                                       │
  bridge (TcpTransport)                                     │
    │                                                       │
    ▼                                                       │
  tailscale0  ── WireGuard (P2P, end-to-end) ──► tailscale0 │
                                                   │        │
                                                   ▼        │
                                          Relay container   │
                                            ├─ tailscaled   │
                                            └─ socat TCP-LISTEN:<port>,fork
                                               UNIX-CONNECT:/var/run/arduino-router.sock ─┘
```

**Key property:** `arduino-router` itself doesn't change. It keeps its `--unix-port`-only configuration from §3. The relay container is a userspace socket proxy the owner opts into. Uninstalling it returns the Q to today's attack surface exactly.

**Integration with n8n is a no-op.** Tailscale operates at the IP/WireGuard layer, transparent to the application stack. n8n sees a hostname and a port, opens a TCP connection, writes bytes — same primitives it uses for a LAN peer. No n8n plugin for Tailscale, no OAuth flow inside n8n, no custom transport inside n8n-workflow. The only n8n-side change is ours: accepting a host/port in the credential.

### 12.2.1 What was considered and rejected

The following alternatives were evaluated during design and rejected. Don't relitigate without new information.

- **Flip `arduino-router`'s `--listen-port` flag.** Research showed the router has a built-in TCP listener (`-l / --listen-port`) that serves the same RPC surface as the unix socket, through the same `router.Accept(conn)` loop. No TLS, no handshake, no auth — a `grep` for `TLS|Authorization|token|authenticate` across the repo returns zero matches. Enabling it unprotected is equivalent to publishing the MCU's full method set to the LAN. Securing it via interface-binding or firewall rules is fragile, misconfigurable, and exposes the router to misconfiguration bugs. The relay container sidesteps this entirely — router stays on its unix socket.
- **DIY PKI with shared secrets or our own CA.** Rejected as reinventing identity infrastructure. Tailscale already solves enrollment, key rotation, ACLs, and NAT traversal — piggy-backing it is strictly better than writing those correctly ourselves.
- **Arduino Cloud-issued X.509 via `arduino-cloud-cli`.** Would require Arduino to extend manual-device provisioning for a "mesh peer" role *and* add `--tls-cert` / `--tls-client-ca` to arduino-router. No roadmap commitment exists (§12.6). Needs upstream cooperation to be real; blocked.
- **MQTT / NATS broker architecture.** A broker on the orchestrator, satellites publish/subscribe. n8n has mature MQTT nodes, so protocol-wise it would work. Rejected because it reshapes our node design around pub/sub semantics, loses the direct-RPC idiom our nodes are built around today, and adds a broker to operate. Bigger refactor, weaker ergonomics.
- **SSH reverse tunnels in production.** Great for dev (already documented in CLAUDE.md), too fragile for production. Tunnels die, need supervision, bake SSH creds into hosts, don't model per-device ACLs.
- **Python proxy on each Q re-exposing the router.** Same objection as the rejected design in §2. Unnecessary hop, unnecessary second language, unnecessary container.
- **Mock router for multi-Q dev.** Earlier section suggested a local mock; rejected here because the existing SSH-tunneled integration tests already exercise real hardware with essentially the same setup cost. Testing on real HW is winner — a mock would add maintenance without adding realism.
- **Relay as a host-level service (systemd unit or bare binary).** Works but means the user has to install packages directly on the Q. Containerising it keeps the install surface uniform (the user already has `docker compose` in their workflow for n8n itself), makes uninstall clean (`docker compose down && rm -rf ...`), and leaves the Q's base image untouched. Also keeps the door open to eventually packaging as an Arduino App Lab Brick (§12.5.4) without reshaping the deliverable.

### 12.2.2 Overlay implementation — Tailscale default, alternatives in scope

**Status (2026-04-23):** kept on record as the intended overlay for Variant B (§12.5.2), which is now deferred. The shipping multi-Q implementation uses Variants A (plain socat on a trusted LAN) and C (stunnel + mTLS for untrusted networks), neither of which needs a WireGuard overlay. If Variant B is ever picked up, the analysis below is the starting point — Tailscale remains the preferred choice.

The §12.2 architecture *originally* committed to a WireGuard-based mesh overlay as the identity+transport layer. This subsection captures the alternatives we evaluated for that slot, why Tailscale was the default, and what we'd switch to under what conditions.

**Why a WireGuard-based mesh VPN rather than an application-layer zero-trust overlay?** For our case, identity verification happens at **credential-selection time** in the n8n UI ("which Q does this node target?"), not at runtime inside a workflow. Once a user has picked "Kitchen Q" as the credential, the bridge just opens a TCP socket — no per-request identity check is needed. A mesh VPN authenticates at the network layer (no valid peer key → no route), which is exactly enough for this model. Application-layer zero-trust adds value only when each call needs its own identity assertion — which we don't.

**The mesh-VPN family (the actual candidates for the default slot):**

- **Tailscale** — *current default*. Hosted control plane (Tailscale Inc., free personal tier), native multi-OS clients, smallest ops surface. Mature, widely deployed, well-documented enrollment UX. We pay a dependency on Tailscale's coordination server (data stays P2P) and require users to create a Tailscale account.
- **Headscale** — self-hosted, OSS drop-in for Tailscale's coordination server. **Uses the same Tailscale client**; the only relay-side change is pointing `tailscaled` at a custom coordination URL via `TS_LOGIN_SERVER=https://headscale.example.com`. Effort to swap: environment variable. Best choice if the hosted control plane is a blocker but the Tailscale client UX is desired.
- **NetBird** — fully OSS WireGuard-mesh: both client and control plane are open source; self-hosted or their SaaS. Own client (still WireGuard under the hood), setup-key-based enrollment. Effort to swap: replace base image and entrypoint. Bonus: REST API for peer state, which makes "is peer X online and authorised?" queryable from an n8n HTTP Request node if we ever want that visibility inside a workflow.
- **Netmaker** — self-hosted, IoT-oriented. Client can be their `netclient` agent OR a plain WireGuard configuration file. Standard WireGuard configs mean that if Arduino ever ships a WireGuard stack on the MCU or the Q's kernel directly, the MCU / host could join the same mesh natively — no relay container needed. Effort to swap: replace base image and entrypoint.
- **ZeroTier** — virtual L2 network (different model from WireGuard's L3). Own client, mature, self-hostable control plane. Effort to swap: replace base image and entrypoint; n8n-side hostname/IP semantics also differ. Included for completeness; no clear win over Tailscale for our topology.
- **Nebula** — certificate-first, you run lighthouses and manage a CA. Effort to swap: replace the entire overlay stack and commit to a CA management story. Strong audit story but operationally heavy for our scale.

**OpenZiti — considered and deferred, not rejected.** OpenZiti is the strongest contender in the identity-first / zero-trust category: it has an official Node.js SDK (`@openziti/ziti-sdk-nodejs`), CA auto-enrollment for mass provisioning, and "dark service" semantics where services are addressed by name instead of hostname. Deferred for v1 because:

- **Transport mismatch.** The SDK's main ergonomic is `ziti.httpRequest(...)`. Our bridge speaks raw msgpack-rpc over a streaming TCP connection — reachable through OpenZiti's lower-level `dial()` primitives, but we'd be wrapping a native-binary npm module around our existing socket code just to replace the socket.
- **Identity model mismatch.** OpenZiti shines when application code needs per-request identity assertion inline. Our identity verification happens at credential-selection time in the n8n UI, once. Paying for a richer mechanism we don't exercise is cost without benefit.
- **Distribution cost for n8n community nodes.** `@openziti/ziti-sdk-nodejs` ships a native binary downloaded during `npm install`, per OS/architecture. This is operationally painful for an n8n community-nodes package: per-arch prebuilds, install failures on constrained hosts, `NODE_FUNCTION_ALLOW_EXTERNAL` gating on restricted n8n deployments.

**Revisit OpenZiti if** an n8n workflow ever needs to assert "the tool caller is really Q-123 right now" as part of a Method guard or similar runtime check. That is OpenZiti's sweet spot and it would earn its cost there.

**Why Tailscale for v1 specifically:**

1. Zero ops on our side — we don't run a control plane.
2. Native clients mean the n8n-host half is a one-line `brew install` / MSI / apt step for the user, not another container to operate.
3. The relay container's `tailscaled` is the one piece of the stack that's easiest to swap later (§12.5.2), so this is a reversible default.

**Switch triggers:**

- **Fully self-hosted, no external SaaS.** Swap to Headscale (env var change) or NetBird (image swap).
- **MCU-direct mesh membership.** Swap to Netmaker (standard WireGuard configs that MCU stacks might one day speak) or, if we tolerate heavy ops, Nebula.
- **Per-call runtime identity assertion.** Change category — OpenZiti.

None of these is a v1 need. Document the escape hatches (§12.5.2), don't build them speculatively.

### 12.3 Bridge HAL refactor

**Goal:** swap the transport under `Bridge` without touching the RPC state machine, msgid allocation, timeout handling, `callWithOptions` retry logic, `provide` / `onNotify` bookkeeping, or the error hierarchy. All protocol behaviour stays in `bridge.ts`; the network layer becomes pluggable.

**Shape (new files under `packages/bridge/src/transport/`):**

```ts
// transport/transport.ts
export interface Transport {
  connect(): Promise<void>;
  write(bytes: Uint8Array): boolean;
  close(): void;
  on(event: 'data',  listener: (bytes: Uint8Array) => void): this;
  on(event: 'close', listener: (err?: Error) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  // (narrow EventEmitter subset; exact shape TBD during implementation.)
}

// transport/unix-socket.ts
export class UnixSocketTransport implements Transport {
  constructor(opts: { socketPath: string }) { /* existing net.createConnection(path) logic */ }
}

// transport/tcp.ts  (new)
export class TcpTransport implements Transport {
  constructor(opts: { host: string; port: number }) { /* net.createConnection({ host, port }) */ }
}
```

**Bridge construction:**

```ts
// bridge.ts — updated signature
static async connect(opts: {
  // Legacy: preserved for backwards compatibility, equivalent to transport: { kind: 'unix', path: socket }.
  socket?: string;
  // New: explicit transport descriptor.
  transport?:
    | { kind: 'unix'; path: string }
    | { kind: 'tcp'; host: string; port: number };
  reconnect?: ReconnectOptions;
}): Promise<Bridge> { … }
```

**Backwards compatibility:** existing `{ socket: '/var/run/arduino-router.sock' }` callers continue to work unchanged. Internally resolved to `{ transport: { kind: 'unix', path: socket } }`. No behaviour change for the existing unit or integration tests.

**Reconnect semantics are transport's business, not Bridge's.** Both `UnixSocketTransport` and `TcpTransport` handle their own low-level reconnection signals (ECONNRESET, ECONNREFUSED, ETIMEDOUT on TCP; equivalent on unix). The exponential-backoff and subscription-replay logic stays in `Bridge` exactly as today — it listens for `close` and `error` events from whatever transport it holds.

**No change to:** codec, msgid allocation, `callWithOptions`, `provide`, `onNotify`, `MockRouter`, error hierarchy, debug logging. The existing unit suite must pass unchanged after the refactor.

**Integration tests:** add a TCP variant gated on `UNOQ_TCP_HOST` + `UNOQ_TCP_PORT` env vars. Same assertions as the existing unix-socket integration suite (§9); only the transport changes. Development execution path: run the socat-only relay container from §12.7 step 1 on the Q and SSH-forward its TCP port to the PC (`ssh -L 5775:localhost:5775 arduino@linucs.local`) — this gives the bridge a stable TCP target without touching `arduino-router`'s systemd unit and without requiring Tailscale to be set up. The Tailscale layer in step 3 just changes the host the bridge connects to, so once the integration suite is green over SSH-forwarded TCP it stays green over tailnet TCP.

**MockRouter:** its transport input is already abstract-ish. Make it fully transport-agnostic by having unit tests construct a Bridge with a `MockTransport` that directly emits bytes, removing any `net.Socket` assumptions that crept in.

### 12.4 n8n Credentials type — `UnoQRouterApi`

**Why now** (vs. §6.5 deferral): §6.5 explicitly listed "TCP support lands" and "multi-Q deployments" as the v2 triggers. Both land here. Credentials become necessary, not decorative.

**Schema (`packages/n8n-nodes/src/credentials/UnoQRouterApi.credentials.ts`):**

```ts
export class UnoQRouterApi implements ICredentialType {
  name = 'unoQRouterApi';
  displayName = 'Arduino UNO Q Router';
  documentationUrl = 'https://github.com/raasimpact/n8n-uno-q/tree/main/packages/n8n-nodes#credentials';
  properties: INodeProperties[] = [
    {
      displayName: 'Transport', name: 'transport', type: 'options',
      options: [
        { name: 'Unix Socket (local)',                   value: 'unix' },
        { name: 'TCP (remote — relay container, etc.)',  value: 'tcp'  },
      ],
      default: 'unix',
    },
    {
      displayName: 'Socket Path', name: 'socketPath', type: 'string',
      default: '/var/run/arduino-router.sock',
      displayOptions: { show: { transport: ['unix'] } },
    },
    {
      displayName: 'Host', name: 'host', type: 'string',
      placeholder: 'uno-q-kitchen.tailnet-abc.ts.net',
      displayOptions: { show: { transport: ['tcp'] } },
    },
    {
      displayName: 'Port', name: 'port', type: 'number',
      default: 5775,
      displayOptions: { show: { transport: ['tcp'] } },
    },
  ];
  // test = custom generic test — see below.
}
```

**Test Connection:** n8n's credential test infrastructure expects either an HTTP request (not applicable — msgpack-rpc isn't HTTP) or a custom generic `test` function. Use the latter: construct a Bridge with the credential's transport, call `$/version`, close, return the router's version string on success or a friendly error message on failure (socket not found, connection refused, timeout, tailnet peer unreachable). Total round-trip should be sub-second on a healthy network.

**Node changes** (all four: `UnoQCall`, `UnoQTrigger`, `UnoQRespond`, `UnoQTool`):

- Declare `credentials: [{ name: 'unoQRouterApi', required: true }]`.
- Remove the per-node `socketPath` parameter from the Advanced Options tab. For one release cycle, keep reading the old parameter as a fallback if a node has no credential assigned; emit a deprecation warning to the n8n log. Then drop the fallback in the following release.
- Resolve the credential at execute/activate time, pass its transport descriptor into `BridgeManager`.

**BridgeManager keying change** ([packages/n8n-nodes/src/BridgeManager.ts](packages/n8n-nodes/src/BridgeManager.ts)): today keyed by socket path. Update the key to a canonical connection descriptor — `unix:/var/run/arduino-router.sock` or `tcp:uno-q-kitchen.tailnet-abc.ts.net:5775` — so multiple Qs in the same workflow get multiple Bridge singletons, one per credential. The `globalThis[Symbol.for(...)]` escape hatch from §7 still applies — unchanged. All of `BridgeManager`'s refcounting, provide/notify dedup, and lifecycle draining logic from §6.3 continues to work per-credential-key, not globally.

**Rate-limiter key update** ([packages/n8n-nodes/src/rateLimiter.ts](packages/n8n-nodes/src/rateLimiter.ts), see §6.4): current key is `${node.id}:${method}`. With multi-Q, a single node could in principle be re-pointed at a different Q via credential edit; for that (rare) case, extending the key to `${node.id}:${method}:${credentialId}` keeps history clean across re-pointing. Low-priority; decide during implementation whether to ship now or defer.

**Workflow portability:** the credential resource means the same workflow JSON runs on a dev laptop (credential → unix, `/tmp/arduino-router.sock`), on the Q itself (credential → unix, `/var/run/arduino-router.sock`), and against a remote Q (credential → tcp, tailnet hostname) with only the credential's values changing. No workflow edits per environment.

**Multi-Q example:** define two credentials, `Kitchen Q` and `Garage Q`. A workflow that reads a temperature sensor on the kitchen and fires a fan relay on the garage is two Call nodes, one per credential, with no other coordination.

### 12.5 Relay container

**Role:** exposes `arduino-router`'s unix socket as a TCP endpoint, optionally wrapped in a mesh-overlay. Runs on each satellite Q. Installed by the user via `docker compose`, same muscle memory as the n8n container. If not installed, the Q stays exactly as it is today — router reachable only via the local unix socket.

**Lives under [deploy/relay/](deploy/relay/) (Variant A) and [deploy/relay-mtls/](deploy/relay-mtls/) (Variant C).** Both are alongside the existing [deploy/n8n/](deploy/n8n/) compose service.

**Three variants, mutually exclusive at the port level but complementary in intent** — A and C shipped as of 2026-04-23; B is designed-but-deferred (see §12.5.2 status note):

- **Variant A — socat-only.** Minimal image: `alpine` + `socat`. Exposes the router's unix socket as a TCP listener bound to an arbitrary interface (loopback, LAN, or anything). No auth, no identity, nothing but byte-pumping. **Useful on its own** for a trusted-LAN setup and as the target the bridge HAL + credentials (§12.7 step 2) are developed against. Binding is controlled by the `UNOQ_RELAY_BIND` env var (default `0.0.0.0` — public on the host's LAN; set to `127.0.0.1` for loopback-only + SSH reverse-tunnel consumers).
- **Variant B — socat + Tailscale.** Adds `tailscaled` on top, so the TCP endpoint is reachable only from devices in the owner's tailnet. Network-layer authentication for untrusted networks. Everything except the enrollment UX and the network-layer transport is identical to Variant A.
- **Variant C — socat replaced by `stunnel` + mTLS.** Listener terminates TLS and requires a client certificate signed by the user's CA. Application-layer authentication on top of plain TCP — orthogonal to Variant B (can be layered with it for defense in depth, or stand alone when a WireGuard overlay is overkill). See §12.5.3. This is the **default recommendation when the LAN is untrusted and Tailscale is not wanted**.

#### 12.5.1 Variant A — socat-only (step 1 deliverable)

**Dockerfile (conceptual):**

```dockerfile
FROM alpine:3                                # minimal, already has docker first-party support on ARM64
RUN apk add --no-cache socat
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

**Entrypoint** — a one-liner, essentially:

```sh
#!/bin/sh
exec socat TCP-LISTEN:${INTERNAL_PORT:-5775},reuseaddr,fork UNIX-CONNECT:/host/var/run/arduino-router.sock
```

The `fork` option on socat gives one child process per incoming TCP connection, each mapping 1:1 to a fresh unix-socket connection to `arduino-router`. The router already supports multiple concurrent clients on its unix socket (§3), so no serialisation is required. socat itself is PID 1 — if it dies, the container exits and the restart policy takes over.

**Why `/host/var/run/arduino-router.sock` and not `/var/run/arduino-router.sock`:** Docker file bind-mounts pin the container's mount entry to the host inode at mount time. Every `systemctl restart arduino-router` unlinks the old socket and creates a new one (different inode), and a file-level bind-mount stays bound to the orphan — `connect(2)` inside the container fails forever until the relay container itself restarts. Verified empirically against the real Q: the file-level mount flaps on every router restart; the directory-level mount recovers automatically. So the relay mounts `/var/run` (directory) under a separate `/host/var/run` path inside the container, and socat dials through the fresh path lookup. See §12.5.1's docker-compose fragment.

**docker-compose fragment (conceptual):**

```yaml
unoq-relay:
  image: ghcr.io/raasimpact/unoq-relay:latest        # built from deploy/relay/q/
  restart: unless-stopped
  ports:
    # Binding is controlled by UNOQ_RELAY_BIND (default 0.0.0.0 — reachable
    # from the host's LAN). Set UNOQ_RELAY_BIND=127.0.0.1 to restrict to
    # loopback and consume via an SSH reverse tunnel (dev laptops or when
    # the LAN is untrusted and you are not yet running Variant C).
    - "${UNOQ_RELAY_BIND:-0.0.0.0}:${UNOQ_RELAY_PORT:-5775}:5775"
  volumes:
    # Directory mount, NOT file mount — see rationale above. Each socat child
    # re-resolves the path, so the socket file the router re-creates on every
    # restart is picked up transparently.
    - /var/run:/host/var/run:rw
```

**Intended test rig for steps 1–2:**

1. User deploys the socat-only container alongside the existing n8n container on the Q (same `docker compose up -d`).
2. From the PC, `ssh -L 5775:localhost:5775 arduino@linucs.local` forwards the Q's loopback port to the PC's loopback — same idiom as the existing unix-socket tunnel, just over TCP.
3. `UNOQ_TCP_HOST=127.0.0.1 UNOQ_TCP_PORT=5775 npm run test:integration -w packages/bridge` exercises the TCP transport end-to-end against the real Q.
4. Local n8n (dev) can target the same loopback with a `UnoQRouterApi` credential (transport=tcp, host=127.0.0.1, port=5775).

This is the whole dev loop for the bridge HAL + credentials work. No Tailscale involved yet.

#### 12.5.2 Variant B — socat + Tailscale

**Status (2026-04-23): deferred as future work.** Variant A + Variant C together cover the audience this design was meant to serve: A for trusted LANs, C for untrusted networks without a third-party dependency. Variant B retains narrow appeal for (a) users who already run a tailnet and want zero per-device PKI, and (b) large fleets (~20+ devices) where individual cert management becomes tedious. The design below is kept on record so that future work can pick it up against a known spec; no implementation lives under `deploy/` today.

**Dockerfile (conceptual):** build on Variant A's entrypoint, swap the base image for Tailscale's, add the tailscaled bootstrap.

```dockerfile
FROM tailscale/tailscale:latest              # official, Alpine-based, maintained upstream
RUN apk add --no-cache socat
COPY entrypoint.sh /entrypoint.sh            # extended version — see below
RUN chmod +x /entrypoint.sh
ENV TS_STATE_DIR=/var/lib/tailscale
VOLUME ["/var/lib/tailscale"]
ENTRYPOINT ["/entrypoint.sh"]
```

**Entrypoint responsibilities (in order):**

1. Start `tailscaled` as a background process, wait for its local API socket to come up.
2. If not already authenticated (state dir empty), run `tailscale up --authkey=${TS_AUTHKEY} --hostname=${TS_HOSTNAME}` to join the tailnet.
3. Configure `tailscale serve --bg --tcp ${TS_PORT:-5775} tcp://127.0.0.1:${INTERNAL_PORT:-5775}` so the tailnet-facing port forwards into the container's loopback.
4. `exec socat TCP-LISTEN:${INTERNAL_PORT:-5775},reuseaddr,fork UNIX-CONNECT:/host/var/run/arduino-router.sock` — the same PID 1 as Variant A. The `/host/var/run` directory mount (not a file mount) is what makes the relay survive `systemctl restart arduino-router` — see §12.5.1.

**docker-compose fragment (conceptual):**

```yaml
unoq-relay:
  image: ghcr.io/raasimpact/unoq-relay-tailscale:latest   # built from deploy/relay/q/ with a -tailscale build target
  restart: unless-stopped
  network_mode: host                                       # simplest path to WireGuard tun + loopback
  cap_add:
    - NET_ADMIN
    - NET_RAW
  devices:
    - /dev/net/tun
  volumes:
    # Directory mount, not file mount — see §12.5.1 rationale.
    - /var/run:/host/var/run:rw
    - tailscale-state:/var/lib/tailscale
  environment:
    TS_AUTHKEY: ${TS_AUTHKEY:?set in .env or pass at run time}
    TS_HOSTNAME: ${TS_HOSTNAME:-uno-q}                     # appears in Tailscale admin + as DNS name in the tailnet
    # TS_PORT / INTERNAL_PORT default to 5775.
volumes:
  tailscale-state:                                          # persists device identity — auth key reused only on first boot
```

**Why `network_mode: host`:** simplest path to (a) give Tailscale's WireGuard driver access to `/dev/net/tun` and userspace routing, and (b) let `socat` still be reachable via loopback for `tailscale serve`. Userspace-networking mode (`TS_USERSPACE=1`) is a fallback if the Q's Docker rejects `NET_ADMIN` or `/dev/net/tun` — worth validating empirically during implementation (§12.8).

**Enrollment UX:**

1. User creates a reusable or (preferred) single-use auth key in the Tailscale admin console, tagged `tag:unoq` so tailnet ACLs can target satellites specifically.
2. User pastes it into the relay container's `.env` file (`TS_AUTHKEY=tskey-auth-...`).
3. `docker compose up -d` boots the relay; `tailscaled` joins the tailnet, advertises the Q at `${TS_HOSTNAME}.${tailnet}.ts.net`.
4. User defines a `UnoQRouterApi` credential in n8n with transport=tcp, host=that hostname, port=5775.
5. Any node referencing that credential can now call MCU methods on that Q.

**Host-side prerequisites on the n8n machine** (not the Q):

- Tailscale installed and enrolled in the same tailnet. Native Tailscale app on macOS / Windows / Linux for dev; the same relay container image (or a standalone `tailscaled`) on the Ventuno Q orchestrator in prod.
- No n8n configuration changes needed. No plugin, no n8n-side Tailscale integration — the tailnet is transparent at the network layer.

**Swapping the overlay.** The Tailscale-specific half of the container is isolated to the base image and the entrypoint's enrollment + serve logic. The socat half, the bind-mount, `/var/run/arduino-router.sock`, our bridge, and the n8n credential schema are all overlay-agnostic. Concretely, to swap Tailscale for another WireGuard-mesh overlay (see §12.2.2 for the candidates):

- **Headscale** — *smallest possible change*. Keep `FROM tailscale/tailscale` and `tailscaled` exactly as-is. Set `TS_LOGIN_SERVER=https://headscale.example.com` in the compose `environment:` block and issue auth keys from your Headscale instance instead of the Tailscale admin console. No image rebuild.
- **NetBird** — swap `FROM tailscale/tailscale` for `FROM netbirdio/netbird` (or equivalent), replace the `tailscale up` + `tailscale serve` calls in the entrypoint with NetBird's `netbird up --setup-key=...` + whatever exposes the container port to the overlay. The socat invocation at the end stays identical. Expected diff: ~20-30 lines in the Dockerfile + entrypoint.
- **Netmaker / ZeroTier / Nebula** — same shape as NetBird (new base image, new enrollment in the entrypoint), with more ceremony around CA / cert management for Nebula.

Nothing on the n8n side changes for any of these swaps — the credential still points at a hostname:port. The hostname format changes (`*.ts.net` → whatever the chosen overlay uses), which is a value in the credential, not a code change.

We don't ship Variant B images for these alternatives in v1. Document the swap path for users who need it; build additional variants only if demand appears.

#### 12.5.3 Variant C — socat replaced by stunnel with mTLS

**Role:** application-layer authentication + transit encryption, terminated at the relay container. Listener is `stunnel`, not `socat` — stunnel handles the TLS handshake, verifies a client certificate signed by the owner's CA, and only then hands the plaintext stream off to its own `UNIX-CONNECT` into `/host/var/run/arduino-router.sock`. No separate socat process is needed; stunnel fills both roles.

**When to deploy Variant C instead of (or in addition to) A/B:**

- **Untrusted LAN, no Tailscale.** You don't want to run a WireGuard overlay (no Tailscale account, no self-hosted coordination server, can't install client on the consuming host, etc.) but the LAN isn't safe to leave Variant A bare on. Variant C is the drop-in replacement.
- **Trusted network but "defense in depth" desired.** Layer Variant C inside Variant B: mTLS on top of the tailnet. A tailnet-peer-gone-rogue still can't reach the router without a valid client cert. Overhead is one container + PKI to maintain.
- **Fleet deployments where cert-based identity is natural.** Each n8n instance gets a client cert bound to its identity; revocation is handled at the cert layer. Scales better than editing compose env per peer.

**Why stunnel specifically (vs. `socat OPENSSL-LISTEN`, ghostunnel, nginx stream, or a custom Go binary):**

- `stunnel` is a ~300 KB Alpine package with 25 years of production use. Single container, single config file, good-enough logging for ops.
- `socat OPENSSL-LISTEN` can do the same job in-process but its error messages on handshake failures are OpenSSL-grade obscure; stunnel's are direct and actionable ("peer did not present a certificate", "certificate verify failed").
- `ghostunnel` is more opinionated (hot-reload, SAN-based ACLs, Prometheus metrics) and worth the extra container when managing > ~10 peers; overkill at the single-user / small-fleet scale Variant C targets.
- `nginx stream` works but drags in nginx's full config surface for a job that fits on half a page.
- A custom Go binary would be the endgame if we wanted to avoid the OpenSSL ABI entirely, but it means shipping and maintaining our own binary and PKI tooling is already the operational burden — not the 100 LOC of `tls.Listen`.

**Dockerfile (conceptual):**

```dockerfile
FROM alpine:3
RUN apk add --no-cache stunnel
COPY stunnel.conf /etc/stunnel/stunnel.conf
# Runs as root inside the container — simpler read-access to the bind-mounted
# /host/var/run/arduino-router.sock and to /etc/stunnel/certs. The threat
# model assumes the container is isolated; escalation from a compromised
# stunnel inside the container gives you what you already had by design.
ENTRYPOINT ["stunnel", "/etc/stunnel/stunnel.conf"]
```

**stunnel.conf (conceptual):**

```ini
foreground = yes       ; run in the foreground so docker sees stunnel's PID
pid =                  ; suppress pid-file creation (container lifecycle handles it)
debug = 4              ; info-level; switch to 5–7 for handshake-trace debugging
output = /dev/stderr

[unoq-relay]
accept = 5775
connect = /host/var/run/arduino-router.sock
cert = /etc/stunnel/certs/server.pem
key = /etc/stunnel/certs/server.key
CAfile = /etc/stunnel/certs/ca.pem
verifyPeer = yes       ; require the client to present a certificate
verifyChain = yes      ; check the presented cert against the CA chain
```

**docker-compose fragment (conceptual):**

```yaml
unoq-relay:
  image: ghcr.io/raasimpact/unoq-relay-mtls:latest       # built from deploy/relay-mtls/q/
  restart: unless-stopped
  ports:
    # mTLS is the gatekeeper, so binding public is the expected default here
    # too (same env var semantics as Variant A, independent port if the user
    # wants Variant A and C side-by-side on different ports).
    - "${UNOQ_RELAY_BIND:-0.0.0.0}:${UNOQ_RELAY_PORT:-5775}:5775"
  volumes:
    - /var/run:/host/var/run:rw
    - ./certs:/etc/stunnel/certs:ro                      # operator supplies ca.pem, server.pem, server.key
```

**Cert prerequisites (operator supplies, one-time setup):**

Three PEM files in `deploy/relay-mtls/q/certs/` on the PC (placeholder dir tracked by `.gitignore`); they land at `$REMOTE_BASE/relay-mtls/certs/` on the Q after `install.sh` runs:

- `ca.pem` — the owner's CA certificate. Used by stunnel to verify incoming client certs.
- `server.pem` — server certificate for *this* Q, signed by the CA. SAN must include the hostname or IP the n8n side will connect to.
- `server.key` — the matching private key.

The n8n side needs three corresponding PEMs in its `unoQRouterApi` credential: `caCert` (same CA as above — used to verify the server), `clientCert` (client certificate, signed by the same CA), `clientKey` (the matching private key).

Concrete bootstrap commands (`openssl` vanilla for the "5-minute demo" path; see §12.5.3 open items for step-ca integration):

```bash
# 1. Home CA, one-time (10y validity).
openssl genrsa -out ca.key 4096
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
  -subj "/CN=MyHome UnoQ CA" -out ca.pem

# 2. Server cert for the Q "kitchen". SAN must match how n8n connects.
openssl genrsa -out kitchen.key 2048
openssl req -new -key kitchen.key -subj "/CN=kitchen" -out kitchen.csr
cat > kitchen.ext <<EOF
subjectAltName = DNS:kitchen.local, IP:192.168.1.42
extendedKeyUsage = serverAuth
EOF
openssl x509 -req -in kitchen.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -days 730 -sha256 -extfile kitchen.ext -out kitchen.pem

# 3. Client cert for the n8n instance.
openssl genrsa -out n8n-laptop.key 2048
openssl req -new -key n8n-laptop.key -subj "/CN=n8n-laptop" -out n8n-laptop.csr
openssl x509 -req -in n8n-laptop.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -days 730 -sha256 -extfile <(echo "extendedKeyUsage = clientAuth") \
  -out n8n-laptop.pem
```

**Bridge / n8n-side impact** (not yet implemented):

- **Sibling `TlsTransport` class**, not an extension of `TcpTransport`. Both extend the shared `socket-base.ts` and call `tls.connect({ host, port, ca, cert, key })` vs `net.createConnection(...)` respectively. Decision (2026-04-23, overrides the earlier draft that nested `tls` inside a `kind: 'tcp'` descriptor): keep the two transports as peers so each class has a single responsibility and consumers (factory, describeTransport, BridgeManager keying) switch cleanly on `kind` without an "is TLS configured?" branch. Transport events stay identical; Bridge's reconnect loop is unchanged.
- **`TransportDescriptor` union gains a third variant** — distinct `kind: 'tls'`:
  ```ts
  export type TransportDescriptor =
    | { kind: 'unix'; path: string }
    | { kind: 'tcp';  host: string; port: number }
    | { kind: 'tls';  host: string; port: number; ca: string; cert: string; key: string };
  ```
- **`describeTransport` keys TLS distinctly from plain TCP** (`tls:host:port` vs `tcp:host:port`), so BridgeManager's connection dedup keeps TLS and plaintext connections to the same endpoint separate.
- **`UnoQRouterApi` credential gains a "Use TLS (mTLS)" boolean** (default off) shown only when `transport === 'tcp'`. When that toggle is on, three *required* multi-line cert fields appear: `caCert`, `clientCert`, `clientKey`. When off, the three fields are hidden and the descriptor resolves to `{ kind: 'tcp', host, port }`; when on, it resolves to `{ kind: 'tls', host, port, ca, cert, key }`. Decision (2026-04-23): the explicit toggle over inferred-from-presence — beginners don't have to understand "three empty fields mean no TLS", and the UI makes the mode visible at a glance.
- No change to any node's behaviour beyond the descriptor carrying TLS material transparently.

**Open items for Variant C:**

- **PKI bootstrap UX.** The raw-`openssl` path above works but is hostile to non-specialist users. Evaluate `step-ca` (smallstep) as an optional guided path — single binary, ACME-style issuance, CA state persisted locally. A wrapper script in `deploy/relay-mtls/pki/` that fronts either `openssl` or `step` behind interactive prompts is probably the right deliverable for v1 of this variant.
- **Cert rotation mechanics.** stunnel needs a restart on cert change (no hot-reload in the Alpine build's default config). For rotation cadence every 1-2 years, `docker compose restart unoq-relay` is acceptable. If rotation frequency increases, reconsider ghostunnel (which does hot-reload).
- **Revocation.** stunnel supports CRLs but the UX to distribute and refresh them on the Q is clunky. Practical alternative for small fleets: re-issue the CA and rotate every cert. Decide based on observed fleet size.

#### 12.5.4 Future App Lab Brick packaging

We know from §12.6 that Arduino's "Bricks" are mechanically Docker containers orchestrated by `arduino-app-cli`, but that third-party Bricks are not a supported category today — the Brick channel is Arduino-curated and there's no public spec, registry, or signing requirement. The relay container above is therefore **not** a Brick; it's a plain docker-compose service the user installs manually.

If Arduino later opens the Brick channel to third-party contributions, this container is a natural candidate: it already matches the shape (image bundles everything, bind-mounts the router socket, long-running service). What would likely change:

- **Installation UX** — from `docker compose up -d` + editing `.env` to an App Lab config form that takes `TS_AUTHKEY` and `TS_HOSTNAME` and materialises the compose entry into `arduino-app-cli`'s generated compose file.
- **Image hosting** — possibly `ghcr.io/arduino/app-bricks/...` instead of our own GHCR org, depending on Arduino's policy.
- **Default port / network-mode choices** — might need to conform to whatever conventions App Lab establishes.

What would *not* change: the container contents (socat + tailscaled), the bridge and n8n side of the stack, or the security model. The relay stays the same relay; only the way a user acquires and configures it differs. So the effort is not wasted if Bricks never open up — and it's cleanly re-packageable if they do.

### 12.5.5 Security model

**Threat model:** the satellite Q sits on an untrusted or semi-trusted LAN. Possible attackers include other devices on the LAN, the user's ISP, public WiFi co-tenants, and (hypothetically) anyone who compromises a device legitimately on the user's tailnet.

**Variant-by-variant defense posture:**

- **Variant A (socat, trusted LAN):** no authentication, no encryption. Applicable only when the LAN is genuinely trusted and the Q's port is reachable only to devices the owner trusts. Set `UNOQ_RELAY_BIND=127.0.0.1` and consume via SSH reverse tunnel when the trust assumption no longer holds. This is the development-and-small-home-LAN shape.
- **Variant B (socat + Tailscale):** network-layer authentication via WireGuard. Every packet is keyed by the peer's public key; no valid key, no route. Per-device ACLs via the tailnet admin. Transit encryption end-to-end. Appropriate for untrusted networks without needing application-layer secrets on the n8n side.
- **Variant C (stunnel + mTLS):** application-layer authentication via client certificate + transit encryption via TLS. Appropriate for untrusted networks when a WireGuard overlay is unwanted, or **layered with Variant B** as defense in depth against compromised tailnet peers.

**Defenses shared across all variants:**

- **Router attack surface is unchanged.** `arduino-router` still listens only on `/var/run/arduino-router.sock`. Nothing on the LAN can reach it directly — only the relay container, via its bind-mount, can initiate unix-socket connections.
- **Out-of-band channels stay put.** App Lab, `arduino-app-cli`, mDNS, etc. are unaffected by the relay deployment.

**Out of scope for this layer:**

- A compromised n8n host already legitimately authenticated (tailnet peer in B; cert holder in C). It can call any MCU method the router exposes. Mitigate at the Method node layer (guards, rate limits, HITL) — the existing §6.4 primitives stay the right answer for this.
- A leaked Tailscale auth key exploited before first enrollment (Variant B). Tailscale recommends single-use + short-TTL keys; the relay container's docs should say the same.
- A leaked client private key (Variant C). Rotate the CA and re-issue certs; at small fleet sizes this is cheaper than maintaining a CRL distribution pipeline. See §12.5.3 open items.
- Physical access to the satellite Q. No network-layer solution addresses this.

**What the model explicitly is *not* (by design in Variant A/B, *available* in Variant C):** application-layer auth on top of msgpack-rpc. Variants A and B push authentication entirely to the network layer — consistent with Tailscale's documented deployment patterns for internal services. Variant C exists for deployments that want defense in depth or that can't run a mesh overlay at all. Picking a variant is a deployment-time choice; the bridge and n8n-side code accept any of them via the `UnoQRouterApi` credential.

### 12.6 Verified findings about the Arduino ecosystem

Captured here so they don't have to be re-researched. All verified against `arduino/arduino-router` source on `main` as of 2026-04-21, the `linucs.local` UNO Q, and public Arduino documentation.

- **`arduino-router` has a TCP listener, but it's off by default.** The `-l / --listen-port` flag wires up a `net.Listen("tcp", addr)` whose accepted connections feed the same `router.Accept(conn)` loop as the unix-socket listener — identical help string ("Listening port for RPC services"), identical method surface (`networkapi`, `hciapi`, `$/serial/*`, `$/version`), no transport-conditional logic anywhere. A TCP client gets the full RPC surface, including `$/serial/open` into the MCU. The shipped systemd unit on the UNO Q uses only `--unix-port` and `--serial-port`. No TLS, no handshake, no auth: `grep` across the repo for `TLS|Authorization|token|authenticate` returns zero matches. The router's trust model is "root on this box owns the socket"; that does not extend over TCP.
- **No secure element on the UNO Q.** MCU is STM32U585 (on-die HUK/PKA/SAES/TRNG, but Arduino does not visibly use them for device identity). MPU is Qualcomm QRB2210 (TrustZone exists in silicon, but no OP-TEE supplicant, no `/dev/tee*`, no `/dev/tpm*`, no `/dev/qseecom*` exposed to Linux). No ATECC608 on any I²C bus. `/etc/arduino*` and `/var/lib/arduino*` contain no factory-provisioned certificate or key.
- **UNO Q registers as a "manual device" in Arduino Cloud.** It receives a `device_id` + `secret_key` pair, not an X.509 certificate — contrast with MKR / Opta / Portenta, which carry factory-provisioned client certs in an ATECC608. The UNO Q's own persistent hardware identity, visible to userspace, is the Qualcomm qfprom serial under `/sys/devices/soc0/serial_number`.
- **"Bricks" are Docker containers orchestrated by `arduino-app-cli`.** No published manifest format, no signing requirement, no registry, no third-party brick channel. `arduino-app-cli daemon` on the Q exposes an unauthenticated localhost REST API for app/brick management. A "brick" shipped by us is, mechanically, a docker-compose service the user opts into.
- **mDNS identity on the LAN.** The Q advertises `_arduino._tcp` on port 80 with a TXT record containing `serial_number=<qfprom>`, `vid=0x2341`, `pid=0x0078`, `auth_upload=yes`. The "auth" is `arduino-create-agent`'s signed-command pattern (Arduino's public key embedded in config; no TLS). Usable as an identifier, not as an authenticator.
- **All Arduino auth precedents are device → cloud outbound mTLS** (MKR/Opta/Portenta via ATECC608 + Arduino Cloud CA; Portenta X8 via Foundries.io). None of them authenticate a peer → device LAN connection. Our use case has no direct precedent inside the Arduino ecosystem — one reason we chose an external network-layer overlay rather than inventing new device-side identity primitives.

**Implication for design:** Arduino has no ready-to-use identity primitive we can piggy-back on for mutual device-to-device authentication. Any such primitive we build would be ours alone. Choosing Tailscale pushes the identity problem onto infrastructure designed for exactly this, rather than inventing a small-footprint version of it.

### 12.7 Implementation order

Target sequence for landing on `feat/multi-q`. Each step was independently reviewable and left the tree green. The as-delivered order was **socat container → bridge HAL + credentials → mTLS relay → PKI wrapper + installers**, driven by "isolate each concern, ship usable slices":

- Step 1 validated the socket-proxy approach in isolation, before any bridge changes existed.
- Step 2 developed the bridge HAL + credentials against a stable TCP target on a trusted LAN — no networking overlay.
- Step 3 added mTLS (Variant C). From n8n's perspective this is still a TCP connection to a hostname, so nothing from step 2 regressed; only the cert material in the credential changed.
- Step 4 wrapped the PKI behind a beginner-friendly CLI + install/uninstall scripts + SSH multiplexing so password-auth users don't get five prompts per deploy.

Each slice is also useful on its own — a release containing only steps 1–2 already served anyone with a trusted LAN.

1. **Variant A relay container — socat only** (§12.5.1) — **shipped.** Image under [deploy/relay/](deploy/relay/); install/uninstall scripts at [deploy/relay/install.sh](deploy/relay/install.sh) and [deploy/relay/uninstall.sh](deploy/relay/uninstall.sh).
2. **Bridge HAL refactor + `UnoQRouterApi` credentials + node wiring** (§12.3, §12.4) — **shipped.** `Transport` interface, `UnixSocketTransport` + `TcpTransport`, `BridgeManager` re-keyed by descriptor, rate-limiter key includes `credentialId`, legacy `socketPath` fallback with one-release deprecation.
3. **Variant C relay container — stunnel + mTLS** (§12.5.3) — **shipped and verified on real hardware (2026-04-23).** `TlsTransport` sibling to `TcpTransport`, `TransportDescriptor` gained `kind: 'tls'`, `UnoQRouterApi` gained "Use TLS (mTLS)" toggle + three PEM fields. Image + compose under [deploy/relay-mtls/](deploy/relay-mtls/).
4. **PKI tooling + installers** (§12.5.3 open item: "PKI bootstrap UX") — **shipped.** [deploy/relay-mtls/pki/](deploy/relay-mtls/pki/) wraps openssl behind `./pki setup | add device | add n8n | list | show | remove`. [deploy/relay-mtls/install.sh](deploy/relay-mtls/install.sh) consumes the generated bundles (takes `--host` + `--device` flags; host falls back to `UNOQ_HOST` env then default). SSH multiplexing ([deploy/lib/ssh-multiplex.sh](deploy/lib/ssh-multiplex.sh)) collapses password-auth prompts to one per invocation; sync.sh retrofitted accordingly.
5. **Variant B relay container — add Tailscale** (§12.5.2) — **deferred as future work.** See §11 priority note (2026-04-23). Design retained in §12.5.2 for the two audiences where Tailscale still beats mTLS (existing tailnet users; fleet sizes where per-device certs are operationally heavy). No implementation under `deploy/` today.
5b. **Variant B (NAT-friendly) — reverse-SSH relay** (§14) — **end-to-end shipped 2026-04-25; credential layout revised 2026-04-26.** Distinct from the deferred Tailscale design under the same Variant-B label; this is the reverse-SSH path that fills the NAT-traversal gap. Three commits per §14.8: Commit 1 (`q/` convention) refactored all three relay packages; Commit 2 shipped `deploy/relay-ssh/` (single-CA `ssh-keygen` PKI after the §14.2 ssh2 verification pivot, `install.sh` / `uninstall.sh`, autossh-on-Alpine container); Commit 3 shipped the n8n-side runtime (`SshServer` singleton in `packages/n8n-nodes` with manual cert blob parsing + `crypto.verify` for signatures, `kind: 'ssh'` descriptor in the bridge HAL, BridgeManager wiring, 18 unit tests). The credential originally landed as a sibling type `UnoQSshApi` per the pre-merge §14.6; folded into `UnoQRouterApi` as a fourth `transport` value on 2026-04-26 to match the §12.5.3 mTLS precedent — see §14.6 follow-up.
6. **Docs + examples** — *partial.* Per-variant READMEs under [deploy/relay/](deploy/relay/), [deploy/relay-mtls/](deploy/relay-mtls/), and [deploy/relay-ssh/](deploy/relay-ssh/); [relay-mtls/pki/README.md](deploy/relay-mtls/pki/README.md) and [relay-ssh/pki/README.md](deploy/relay-ssh/pki/README.md). Top-level README now lists all three variants. Still pending: [CLAUDE.md](CLAUDE.md) troubleshooting entries for the mTLS failure modes discovered during hardware verification (stunnel inline-comment parsing, `verifyPeer` vs `verifyChain`, TLS-host-must-match-cert-SAN) and the relay-ssh-specific ones (host-cert principal mismatch, KeyID collision, expired user cert, revoked-serial enforcement); example workflow under `examples/multi-q/` with two credentials.

### 12.8 Open items

- **Arduino's roadmap for `--listen-port` auth.** File a question on `arduino/arduino-router` asking whether the TCP listener is a supported production interface and whether TLS / client-cert auth is on the roadmap. If yes, there may eventually be a simpler v2.1 path that drops the relay container in favour of the router's native TLS — unlikely near-term, worth on record. Draft of the question lives in the `feat/multi-q` thread history.
- **Ventuno Q availability.** If/when the Ventuno Q ships, re-verify Variants A and C run on its hardware (same Docker stack expected).
- **Multiple-Q authoring UX.** With credentials landed, check the node-picker and credential dropdown don't feel clunky once a user has 5+ credentials defined. Possibly worth interpolating credential name into node display when a credential is bound, so canvas reads "Kitchen Q · Call" rather than just "Call".
- **Queue-mode incompatibility still stands.** Multi-Q does nothing to fix it (§6 singleton-client note remains). Flag in docs; both the singleton and the rate limiter remain per-process.
- **CRL / hard-revocation for Variant C.** Small fleets can re-bootstrap the CA to revoke; fleets large enough to find that painful are the same fleets that would be better served by Variant B. Not worth wiring CRL distribution through stunnel for the MVP audience.
- **Future-work-only (Variant B, if revisited):** Validate empirically that `network_mode: host` + `cap_add: [NET_ADMIN, NET_RAW]` + `/dev/net/tun` are accepted on the Q's Docker runtime, with `TS_USERSPACE=1` as the fallback; auth-key rotation UX when a relay container restarts after an expired key.

### 12.9 Related sections

- §2 — Architecture decision (direct to router, no Python proxy). Multi-Q keeps this invariant: no extra language, no extra process on the Q other than the relay container (which is a userspace socket proxy, not an RPC translator).
- §5 — Bridge package API. §12.3 is a refactor *under* this API; the public shape gains a `transport:` option but stays backwards-compatible.
- §6.3 — BridgeManager singleton and refcount. §12.4's keying change (socket path → canonical connection descriptor) is a local change inside BridgeManager, not a contract change.
- §6.4 — Method node guards and rate limits. These remain the application-layer defense for compromised tailnet peers (§12.5.1).
- §6.5 — "Credentials deferred to v2". Superseded here; see cross-reference at the top of that section.
- §8 — Open items. Multi-Q-specific opens live here in §12.8; §8 stays focused on v1 hardware verification items.
