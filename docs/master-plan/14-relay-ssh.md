## 14. Reverse-SSH relay (`deploy/relay-ssh/`)

**Status:** designed, not yet implemented. Master-plan reference for the third relay variant — fills the NAT-traversal gap between Variants A (trusted LAN) and C (mTLS over public IP). Sits alongside §12.5; the §12 nomenclature ("Variant B") is reused informally below for users who already speak in those terms, but the implementation has nothing to do with the deferred Tailscale design in §12.5.2.

### 14.1 Motivation — the NAT-traversal gap

Today's two shipped relays both require the **device** to host the listener, with n8n dialling in. That works on a trusted LAN (Variant A) and over an untrusted-but-routable network (Variant C — mTLS), but breaks when the device sits behind NAT with no public IP and no port forwarding — which is the dominant home-Internet shape.

The fix is to flip the direction: the device initiates an **outbound** connection to the always-reachable n8n host, and n8n reaches the device through that established channel. SSH's reverse port forwarding (`ssh -R`) is the canonical primitive for this; the third relay packages it.

The audience this serves: users who run n8n at home or on a small VPS, want to connect a UNO Q sitting on a friend's home network or a colocated office, and don't want to deal with port-forwarding configurations on routers they don't own.

### 14.2 Architecture decision — `ssh2` (Node) replaces a server container

Verified against the [`mscdex/ssh2`](https://github.com/mscdex/ssh2) library docs (current as of 2026-04-25). All three load-bearing capabilities are present:

1. **OpenSSH user-cert auth.** The publickey auth callback exposes `ctx.key.cert` with `principals`, `validAfter`, `validBefore`, `criticalOptions`, `extensions`, `signatureKey`, and `keyId`.
2. **Server-side `tcpip-forward`.** Global request `name === 'tcpip-forward'` is delivered to a `client.on('request', ...)` handler. Forwarding back is via `client.forwardOut(bindAddr, bindPort, srcAddr, srcPort, cb)` returning a duplex stream.
3. **Host certificates.** `hostKeys: [{ key, cert }]` makes the server present a host cert during KEX, so devices verify it via `@cert-authority` in `known_hosts`.

**Consequence:** the n8n side becomes a Node module, not a container. The whole reverse-SSH endpoint is part of the `n8n-nodes-uno-q` runtime — boot/refcount/teardown follows the same singleton-on-`globalThis` pattern as `BridgeManager` (§7). On the Q, only one container runs (autossh client). One install script, no per-port allocation visible to the user, no `host.docker.internal` gotcha.

This is a deliberate departure from the symmetry of Variants A/C, where both ends are containers. The asymmetry pays for itself in operational simplicity: the n8n-side install is "paste the bundle into a credential," not "rsync a stack and `docker compose up`."

**Alternatives considered and rejected during the 2026-04-25 design** (don't relitigate without new information):

- **Tailscale + relay-mtls retained** — pointed at "deferred future work" in §12.5.2; the n8n-server side stays a documentation-only tier (paste a `tailscale up --authkey=…` snippet into n8n-server/README, no code). Useful for users who already run a tailnet, but doesn't fix the NAT-traversal problem for users who don't, which is the population this section targets. Kept available, not built.
- **FRP / rathole / chisel / bore** — purpose-built reverse-tunnel servers. Each adds a daemon on the n8n side, weaker auth than SSH-CA, and no real advantage over SSH except "uses HTTP/443 if SSH is blocked outbound." Not the right trade for our audience.
- **`sish`** — productized reverse-SSH server. Intriguing because it bakes in subdomain routing and a dashboard, but adds an HTTP entry point and another daemon to operate. Overkill for pure TCP-to-unix-socket bridging.
- **Headscale (self-hosted Tailscale control plane), Netbird, Innernet, Nebula** — full mesh-VPN options. Strictly more powerful than reverse-SSH but require a daemon on every device. The reverse-SSH path keeps the device side to a single Alpine container with autossh; that minimalism is the value.
- **Reverse SSH with stock `sshd` on the n8n host** — would work but requires the user to edit `sshd_config` on their n8n host. Embedding `ssh2` as a Node module avoids that and keeps the install to "paste a bundle."

Re-read §12.5.2 if revisiting Tailscale; this section is reverse-SSH-specific.

### 14.3 Two-CA SSH PKI

OpenSSH has two cert types and we need both:

- **User CA** — signs *user* certs. The n8n-side `SshRelayServer` trusts it as the equivalent of `sshd`'s `TrustedUserCAKeys`. Each Q gets a user cert with principal `tunnel`, `KeyID = <nick>`, 90-day validity, and a `permit-port-forwarding` extension.
- **Host CA** — signs *host* certs. The n8n-side server presents a host cert. Each Q's autossh trusts it via `@cert-authority` in `known_hosts`, so the Q verifies the n8n host's identity without TOFU.

`pki setup` generates both CAs once on the PC. The PKI CLI mirrors the existing [deploy/relay-mtls/pki/](../../deploy/relay-mtls/pki/) shape — `setup | add device | add n8n | list | show | remove` — so the muscle memory carries over verbatim.

**Per-command behaviour (port from relay-mtls/pki, swapping `openssl` for `ssh-keygen`):**

| Command | Action | Output bundle |
|---|---|---|
| `pki setup` | `ssh-keygen -t ed25519` × 2 → `ca/user_ca`, `ca/host_ca` (private + `.pub`). Idempotent: refuses if either CA already exists. | `pki/ca/{user_ca,user_ca.pub,host_ca,host_ca.pub}` |
| `pki add device <nick>` | gen ed25519 keypair → sign **user** cert with `user_ca`: principal `tunnel`, `KeyID = <nick>`, validity 90d, extension `permit-port-forwarding`, no other extensions. Refuses if `<nick>` already lists an active row in `certs.tsv`. | `pki/out/devices/<nick>/{id_ed25519, id_ed25519-cert.pub, host_ca.pub}` |
| `pki add n8n <nick>` | gen ed25519 keypair → sign **host** cert with `host_ca`: `-h` (host-cert flag), principal = the listen hostname (user-prompted or `--hostname`), validity 1y. | `pki/out/n8n/<nick>/{ssh_host_ed25519_key, ssh_host_ed25519_key-cert.pub, user_ca.pub}` |
| `pki list` / `pki show <nick>` | print `certs.tsv` table or per-cert detail (`ssh-keygen -L -f <cert>`). Identical UX to relay-mtls. | — |
| `pki remove <nick>` | flips `certs.tsv` row to `decommissioned`, appends the cert serial to `pki/revoked_serials`, deletes `out/<kind>/<nick>/`. The revoked serials file is what gets pasted into the credential's "Revoked serials" field. | — |

Validity defaults (`USER_CERT_DAYS=90`, `HOST_CERT_DAYS=365`) live in `pki/lib/common.sh` to mirror relay-mtls's structure.

### 14.4 Identification — by `cert.keyId`, not by port

`ssh-keygen -s ca/user_ca -I <nick> ...` writes `<nick>` into `cert.keyId`. The n8n-side `SshRelayServer` stores it on the client object during auth, then:

```js
client.on('request', (accept, reject, name, info) => {
  if (name !== 'tcpip-forward') return reject();
  // Evict any prior client claiming this keyId (zombie reconnect case)
  registry.get(deviceNick)?.client.end();
  registry.set(client._deviceNick, { client, bindAddr: info.bindAddr, bindPort: info.bindPort });
  accept(info.bindPort);
});
```

When an n8n node calls `relay.connect(deviceNick)`:

```js
const entry = registry.get(deviceNick);
entry.client.forwardOut(entry.bindAddr, entry.bindPort, '127.0.0.1', 0, (err, channel) => {
  // channel is a Duplex stream wired straight to /var/run/arduino-router.sock on the Q
});
```

The autossh container on the Q passes `-R 127.0.0.1:7000:/host/var/run/arduino-router.sock` — the port number `7000` is arbitrary and not used as a routing key. Routing is **only** by `keyId`, which is part of what the user CA signed. A compromised device cannot impersonate another: the CA never signed a cert with someone else's keyId.

### 14.4b Concrete `deploy/relay-ssh/` layout

```
deploy/relay-ssh/
├── README.md                           # package-level intro + quick start
├── install.sh                          # ./install.sh --device <nick> [--host user@uno-q]
├── uninstall.sh                        # ./uninstall.sh [--host user@uno-q]
├── n8n-server/
│   └── README.md                       # paste-into-credential flow + listen-port reachability prereq
├── pki/
│   ├── pki                             # CLI dispatcher (entry point)
│   ├── lib/
│   │   ├── common.sh                   # paths, defaults (USER_CERT_DAYS, HOST_CERT_DAYS), helpers
│   │   ├── setup.sh                    # implements `pki setup`
│   │   ├── add.sh                      # implements `pki add device|n8n`
│   │   ├── list.sh                     # implements `pki list`
│   │   ├── show.sh                     # implements `pki show`
│   │   └── remove.sh                   # implements `pki remove`
│   ├── ca/                             # gitignored: user_ca, user_ca.pub, host_ca, host_ca.pub
│   ├── out/                            # gitignored: devices/<nick>/, n8n/<nick>/
│   ├── certs.tsv                       # registry: <nick>\t<kind>\t<state>\t<expiry>\t<serial>
│   ├── revoked_serials                 # appended to by `pki remove`
│   ├── .gitignore
│   └── README.md                       # full PKI walkthrough
└── q/
    ├── Dockerfile                      # alpine + autossh + openssh-client
    ├── docker-compose.yml              # restart: unless-stopped, mounts /var/run + ./certs
    ├── entrypoint.sh                   # autossh exec with -R + cert
    └── certs/
        └── .gitignore                  # placeholder: `*` + `!.gitignore`
```

`install.sh` flag interface mirrors [deploy/relay-mtls/install.sh](../../deploy/relay-mtls/install.sh): `--device <nick>` (required, picks the bundle from `pki/out/devices/<nick>/`), `--host <user@host>` (optional, falls back to `UNOQ_HOST` env then `arduino@linucs.local` default). `uninstall.sh` takes only `--host`.

### 14.5 The `q/` convention (refactor of all three relay packages)

**Decision (2026-04-25):** every relay package's container assets live under a `q/` subfolder. The package root holds only what runs on the PC (`install.sh`, `uninstall.sh`, `README.md`, and where present `pki/`). This applies to relay, relay-mtls, and relay-ssh. `q/` reads as "what runs on the Q" — accurate for all three (relay-ssh's Q-side is technically an SSH client, but `q/` is unambiguously about deployment target, not protocol role).

Concrete shape:

```
deploy/<relay-package>/
├── README.md
├── install.sh
├── uninstall.sh
├── pki/                       (relay-mtls and relay-ssh only)
└── q/
    ├── Dockerfile
    ├── docker-compose.yml
    ├── (entrypoint.sh / stunnel.conf / ...)
    └── certs/.gitignore        (relay-mtls and relay-ssh only — placeholder)
```

The `certs/.gitignore` placeholder (one line: `*` plus `!.gitignore`) keeps the bind-mount path resolvable in fresh clones. `install.sh` rsyncs `q/` to the Q's `$REMOTE_BASE/<package>/` and the cert bundle separately into `<package>/certs/`. The remote layout on the Q is unchanged versus today — only the local layout in the repo gets the `q/` level.

Knock-on changes:

- `install.sh` rsync source: `"$SCRIPT_DIR/"` → `"$SCRIPT_DIR/q/"`. Excludes simplify because `pki/` and the scripts are no longer siblings.
- `deploy/sync.sh` likewise: source paths become `./deploy/<package>/q/`. The `--exclude pki --exclude install.sh --exclude uninstall.sh` list collapses to just `--exclude certs` for relay-mtls and relay-ssh (operator-supplied — must not be wiped by `--delete` since the local placeholder has only `.gitignore`).

### 14.6 `UnoQSshRelayApi` credential (n8n side)

Field reference. Multiline PEM/key fields use plain `string` with `typeOptions: { rows: N, password: false }` — **never** `typeOptions: { password: true }`.

**Why** (recorded after the relay-mtls hardware-verification incident, 2026-04-23): n8n's password-masked multiline textarea reformats the stored value in a way that downstream PEM/OpenSSH parsers refuse — whitespace and newlines in the PEM/cert blob no longer round-trip cleanly. Switching to plain (non-password) multiline fields fixed it. Trade-off: the secret is visible in the credential editor, accepted because n8n encrypts credential storage at rest. The same rule already applies in [UnoQRouterApi.credentials.ts](../../packages/n8n-nodes/src/credentials/UnoQRouterApi.credentials.ts) for the mTLS PEM fields — see the explicit `password: false` and the `// NOT password: true` comment block there.

**Single-line secrets** (tokens, passwords) can still use `password: true` safely — the bug is specific to the multiline + password-mask combination on PEM-shaped payloads.

| # | Field | Type | Notes |
|---|---|---|---|
| 1 | Device nickname | string | Routing key. Matches `pki add device <nick>`'s `<nick>`. |
| 2 | Listen address | string, default `0.0.0.0` | Where the embedded `ssh2.Server` binds. |
| 3 | Listen port | number, default `2222` | TCP port for incoming Q connections. |
| 4 | Host private key | string + `rows: 8, password: false` | From `pki/out/n8n/<nick>/ssh_host_ed25519_key`. |
| 5 | Host certificate | string + `rows: 4, password: false` | From `pki/out/n8n/<nick>/ssh_host_ed25519_key-cert.pub`. |
| 6 | User CA public key | string + `rows: 2, password: false` | From `pki/out/n8n/<nick>/user_ca.pub`. |
| 7 | Required principal *(Advanced)* | string, default `tunnel` | Defense-in-depth check. |
| 8 | Revoked serials *(Advanced)* | string + `rows: 4, password: false` | One serial per line. |
| 9 | Connect timeout (ms) *(Advanced)* | number, default `10000` | Wait time for `connect(deviceNick)` against an absent registry entry. |
| 10 | Idle disconnect (s) *(Advanced)* | number, default `0` | `0` = never. |

Test Connection: boot/reuse the singleton, lookup `registry.get(deviceNick)`, and either return "device not currently connected" or do `forwardOut → BridgeManager → call('$/version')` and echo the result.

Multiple credentials per server are expected: one credential per (n8n-host, device) pair. They share the singleton server inside n8n; the credential is just the lookup pointer.

### 14.7 Q-side autossh container (`deploy/relay-ssh/q/`)

`q/Dockerfile`:

```dockerfile
FROM alpine:3
RUN apk add --no-cache autossh openssh-client
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

`q/entrypoint.sh`:

```sh
#!/bin/sh
set -eu
mkdir -p ~/.ssh
echo "@cert-authority ${N8N_HOST} $(cat /etc/relay-ssh/host_ca.pub)" > ~/.ssh/known_hosts
exec autossh -M 0 -N \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=yes \
  -i /etc/relay-ssh/id_ed25519 \
  -o CertificateFile=/etc/relay-ssh/id_ed25519-cert.pub \
  -R "127.0.0.1:7000:/host/var/run/arduino-router.sock" \
  -p "${N8N_SSH_PORT:-2222}" \
  "tunnel@${N8N_HOST}"
```

`q/docker-compose.yml`: `restart: unless-stopped`, mounts `/var/run:/host/var/run:rw` (directory mount per §12.5.1) and `./certs:/etc/relay-ssh:ro` (cert bundle). Env: `N8N_HOST`, optional `N8N_SSH_PORT`. autossh is PID 1; its `-M 0` + `ServerAliveInterval` combo handles reconnection internally — no systemd, no host-OS edits.

### 14.8 Implementation order — three commits

**Commit 1 — Introduce `q/` convention (refactor only).**

- *File moves via `git mv`:* relay's `Dockerfile`, `docker-compose.yml`, `entrypoint.sh` → `relay/q/`. relay-mtls's `Dockerfile`, `docker-compose.yml`, `stunnel.conf`, `certs/` → `relay-mtls/q/`.
- *`install.sh` updates (both packages):* rsync source `"$SCRIPT_DIR/"` → `"$SCRIPT_DIR/q/"`. Drop `--exclude pki --exclude install.sh --exclude uninstall.sh` (no longer siblings of `q/`). Keep `--exclude certs` in relay-mtls.
- *`deploy/sync.sh` updates:* source paths become `./deploy/relay/q/` and `./deploy/relay-mtls/q/`. Excludes collapse — only `--exclude certs` remains, only for relay-mtls. Header comment block gets a one-line update describing the convention.
- *Doc updates:* top-level [README.md](../../README.md) — curl URLs at lines 82-84 (`deploy/relay/Dockerfile` → `deploy/relay/q/Dockerfile`, etc.) and the layout tree at lines 243-245 (add `q/` level). [docs/master-plan/12-multi-q.md](12-multi-q.md) — descriptive `built from deploy/relay/` references in §12.5.1, §12.5.2, §12.5.3 gain `/q/` suffix; §12.5.3's "PEM files in `deploy/relay-mtls/certs/`" becomes "PC-side placeholder at `deploy/relay-mtls/q/certs/`; deployed certs land at `$REMOTE_BASE/relay-mtls/certs/` on the Q." Per-package READMEs ([deploy/relay/README.md](../../deploy/relay/README.md), [deploy/relay-mtls/README.md](../../deploy/relay-mtls/README.md)) — add a one-line "Source layout" note. [CLAUDE.md](../../CLAUDE.md) — scan for stale paths; expected to be no-op.
- *Behaviour:* identical end-to-end. The remote layout on the Q is unchanged.
- *Verification:* `./deploy/sync.sh` against the real Q. Then `./deploy/relay/install.sh --host arduino@<q>` and `./deploy/relay-mtls/install.sh --device <nick> --host arduino@<q>` round-trips, including stunnel handshake.

**Commit 2 — Ship `deploy/relay-ssh/` (deploy tooling only).**

- *New files:* the full layout in §14.4b above. PKI scripts ported from [relay-mtls/pki/lib/](../../deploy/relay-mtls/pki/lib/), `openssl` calls replaced with `ssh-keygen` per the table in §14.3.
- *Q-side container:* per §14.7. autossh-in-Alpine, no host-OS edits.
- *`deploy/sync.sh` additions:* third `mkdir -p` entry for `relay-ssh`; third rsync block with `--exclude certs`.
- *Doc updates:* top-level [README.md](../../README.md) — new variant row "B — reverse SSH" / "Behind NAT, no public IP needed" / "SSH user-cert PKI"; new "Setup the reverse-SSH relay" section paralleling the mTLS one; layout tree adds `deploy/relay-ssh/`. [docs/master-plan/12-multi-q.md](12-multi-q.md) §12.7 — new implementation-order entry referencing this section. [CLAUDE.md](../../CLAUDE.md) — troubleshooting table gains 1-2 rows for ssh-cert mismatches and stale connections; "Repo shape" mentions the third deploy unit.
- *Verification:* end-to-end against a stub `ssh2.Server` in `experiments/mock-ssh-relay.mjs`. PKI bootstrap (`pki setup` → `add n8n` → `add device`) → `install.sh` against the Q → autossh container comes up → stub server logs the keyId + `tcpip-forward` accept.

**Commit 3 — `SshRelayServer` in `packages/n8n-nodes`.**

- *New code:* `packages/n8n-nodes/src/SshRelayServer.ts` (singleton on `globalThis` keyed by `Symbol.for('@raasimpact/arduino-uno-q/ssh-relay')`, wraps `ssh2.Server`, auth callback per §14.4, registry per §14.4, eviction on keyId collision). `packages/n8n-nodes/src/credentials/UnoQSshRelayApi.credentials.ts` per §14.6 (no `password: true` on multiline fields). [BridgeManager.ts](../../packages/n8n-nodes/src/BridgeManager.ts) wiring: new `Transport: 'ssh-relay'` resolves to `SshRelayServer.getInstance(creds).connect(creds.deviceNick)`.
- *Tests:* unit suite covers valid cert / wrong CA / expired / missing principal / missing `permit-port-forwarding` extension / revoked serial / keyId collision (second client evicts first). Integration test gated on `UNOQ_SSH_RELAY=1`, spawns `SshRelayServer` + autossh client + runs the round-trip suite.
- *Doc updates:* [packages/n8n-nodes/README.md](../../packages/n8n-nodes/README.md) — new "SSH Relay transport" section. [docs/master-plan/12-multi-q.md](12-multi-q.md) §12.4 — `UnoQSshRelayApi` added to the credential-types table. [docs/master-plan/12-multi-q.md](12-multi-q.md) §12.7 — entry flips from "deploy tooling only" to "end-to-end shipped." [deploy/relay-ssh/n8n-server/README.md](../../deploy/relay-ssh/n8n-server/README.md) — replaces the "credential type to be implemented" placeholder with concrete field reference.
- *Verification:* all unit tests green; integration test green against a Q with autossh running; manual end-to-end — credential created with `kitchen-q` as Device nickname, *Test Connection* returns `$/version` from the real Q, then a `UnoQCall` node executes through ssh2.Server → forwardOut → BridgeManager → router socket on the Q.

Strict serial: each commit's verification gates the next. Commit 1 alone is mergeable; the new `relay-ssh` package waits on it.

### 14.9 Open items

- **Queue-mode singleton scope.** Same limitation as the rest of the package (§6 singleton-client note, §12.8). The `SshRelayServer` lives per-process, so n8n queue mode would need one ssh2.Server per worker — incompatible with a single listen port. Document as a v1 limitation.
- **`pki add device <nick>` collision.** The script must refuse if `<nick>` already exists in `certs.tsv` as an active cert (mirrors relay-mtls's behaviour). Otherwise two certs claim the same `keyId` and registry routing becomes last-writer-wins. Same logic in `pki remove <nick>` flips the row to "decommissioned" and writes the cert serial to `revoked_serials`.
- **Zombie reconnect.** When a Q's autossh hiccups and reconnects while the old TCP session is in zombie state on the n8n side, two clients may briefly claim the same `keyId`. The server must evict the old `ClientCx` (close it explicitly) before storing the new one. Bake into the registry from day one.
- **Listen port reachable from the device.** This is *the* deployment prerequisite. The n8n host must expose port 2222 (or whatever Listen port is configured) to the Internet — same issue any home n8n user already solves to run n8n at home. Document prominently in the `n8n-server/README.md`.
- **`ssh2` user-cert API edge cases.** Verify during implementation: cert-with-no-extensions handling, force-command interaction with `tcpip-forward` only flow, behavior when `principals` is empty (universal cert) — should be rejected.

### 14.10 Related sections

- §12 — Multi-Q support. Variants A and C are the existing relay shipping shapes; this section adds a third. The `q/` convention introduced here applies retroactively to those two packages.
- §12.4 — `UnoQRouterApi` credential. `UnoQSshRelayApi` is a sibling credential type; the bridge HAL gains a `Transport: 'ssh-relay'` resolution path.
- §6.3 — BridgeManager singleton pattern. `SshRelayServer` reuses the `globalThis[Symbol.for(...)]` trick for the same reason.
- §7 — Dev workflow. Pattern A (bind-mount dev) is unchanged; relay-ssh's Q-side ships through the same `deploy/sync.sh` path.
