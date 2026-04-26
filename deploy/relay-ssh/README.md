# `deploy/relay-ssh/` — Variant B relay (reverse SSH, NAT-friendly)

A reverse-SSH tunnel: the Q dials out to your n8n host and exposes its `arduino-router` socket through that established channel. Nothing on the Q's network needs to be reachable from the outside — port forwarding, public IPs, and dynamic-DNS are out of scope.

See [docs/master-plan/14-relay-ssh.md](../../docs/master-plan/14-relay-ssh.md) for the full design — single user-CA + host-key fingerprint pinning architecture, identification by `keyId`, asymmetry rationale, rejected alternatives.

## When to use this vs the other relays

| | [Variant A](../relay/) | This (Variant B) | [Variant C](../relay-mtls/) |
|---|---|---|---|
| Trusted home LAN | ✓ | overkill | overkill |
| Q behind NAT, no public IP | not possible | ✓ | not possible |
| Q has a public IP / port-forward | ✓ | ✓ | ✓ |
| You want encryption in transit | no | ✓ | ✓ |
| You want per-device identity | no | ✓ | ✓ |
| Server side runs in n8n itself (no extra container) | n/a | ✓ | n/a |
| Simplest possible setup | ✓ | requires PKI + a reachable n8n host | requires PKI |

Variant B is the right pick when **the n8n host can be reached from the Q** but **the Q cannot be reached from n8n** — the classic NAT-ed home network. The asymmetric setup is deliberate: the Q only needs an `autossh` container; the SSH server runs *inside* the n8n process (singleton on `globalThis`, like `BridgeManager`), so there's nothing extra to install on the n8n side.

## What's in this directory

| File / dir | Purpose |
|---|---|
| `q/Dockerfile` | Alpine + autossh + openssh-client. |
| `q/entrypoint.sh` | autossh dialer; reads `N8N_HOST` / `N8N_SSH_PORT` from env, mounts cert/key bundle from `/etc/relay-ssh`. |
| `q/docker-compose.yml` | Outbound-only client; no exposed ports. Bind-mounts `/var/run` for the router socket and `./certs` for the auth material. |
| `q/certs/` | PC-side placeholder (only a `.gitignore`); the real bundle lands at `$UNOQ_BASE/relay-ssh/certs/` on the Q after install. |
| `install.sh` | Deploy to a Q. Requires `--device <nick>`, `--n8n <nick>`, `--n8n-host <hostname>`; accepts `--n8n-port <p>` and `--host <user@q-host>`. |
| `uninstall.sh` | Remove from a Q. Accepts `--host <user@host>`. |
| `pki/` | PC-only issuance tooling — single user CA, per-device user certs, per-n8n host keypairs (no host certs — see below). **Never shipped to the Q.** See [pki/README.md](pki/README.md). |
| `n8n-server/` | Notes for running the n8n side (listen-port reachability, credential paste flow). See [n8n-server/README.md](n8n-server/README.md). |

**Source layout.** Everything that runs on the Q lives under `q/`; the package root holds only PC-side scripts, docs, and the `pki/` tooling. `install.sh` rsyncs `q/` to `$UNOQ_BASE/relay-ssh/` on the Q (auth material is pushed separately into `relay-ssh/certs/`). Convention shared with [../relay/](../relay/) and [../relay-mtls/](../relay-mtls/) — see [docs/master-plan/14-relay-ssh.md §14.5](../../docs/master-plan/14-relay-ssh.md).

## Trust model — asymmetric

The PKI is intentionally lopsided because the two directions of trust have different requirements (and ssh2 v1.17 forces our hand on one of them — see [master-plan §14.2 follow-up](../../docs/master-plan/14-relay-ssh.md)).

- **Server trusts client (n8n verifies the Q):** **CA-signed.** The user CA signs each device's cert. n8n loads the user CA pubkey at credential setup time and accepts any device cert it has signed. New Qs join the fleet by issuing a cert against the same CA — no n8n-side change.
- **Client trusts server (Q verifies n8n):** **Host-key fingerprint pinning.** The n8n endpoint presents a bare host key (no host cert). Each device's `known_hosts` is pre-populated at install time with that exact pubkey. Rotating the n8n host key requires re-running `install.sh` on every Q.

For a small fleet (one to a few dozen Qs) the host-key rotation cost is acceptable; CA-based device authentication keeps onboarding new Qs cheap. If host-key rotation becomes painful at scale, options are: (a) patch ssh2 to advertise host certs and switch to `@cert-authority`, (b) automate `install.sh` re-runs across the fleet.

## End-to-end workflow

```
┌─ PC ──────────────────────────────┐    ┌─ n8n host (reachable) ────┐    ┌─ Q (NAT-ed) ───────────┐
│                                   │    │                           │    │                        │
│  ./pki setup                      │    │                           │    │                        │
│  ./pki add n8n laptop             │    │                           │    │                        │
│  ./pki add device kitchen         │    │                           │    │                        │
│                                   │    │                           │    │                        │
│  paste laptop bundle              │    │  Listen :2222 inside n8n  │◄───┤  autossh -R 7000:sock  │
│  into n8n credential ────────────►│────│  (ssh2.Server singleton)  │    │  (outbound only)       │
│                                   │    │                           │    │                        │
│  ./install.sh --device kitchen ───┼────┼───────────────────────────┼───►│  /home/arduino/relay-ssh│
│      --n8n laptop                 │    │                           │    │    docker compose up -d│
│      --n8n-host n8n.example.com   │    │                           │    │                        │
└───────────────────────────────────┘    └───────────────────────────┘    └────────────────────────┘
```

The PKI lives entirely on the PC. `install.sh` ships **two pieces** to the Q's `certs/` dir: the device cert + private key (from `pki/out/devices/<device>/`) and the n8n endpoint's pinned host pubkey (from `pki/out/n8n/<n8n>/`). The host pubkey is the only "trust the server" material; there is no host cert to validate.

The n8n endpoint's host private key + the user CA pubkey are pasted into the n8n credential — the SSH server is *inside* n8n itself.

Routing on the n8n side is keyed by the cert's **KeyID** (set to `<nick>` at issue time). The Q-side `-R 127.0.0.1:7000:/host/var/run/arduino-router.sock` always uses port 7000 — that port is arbitrary and not used as a routing key.

## Install

### First time

```bash
# 1. Create your user CA (once, ever).
./pki/pki setup

# 2. Generate a host keypair for your n8n SSH endpoint.
./pki/pki add n8n laptop

# 3. Issue a user cert for this Q.
./pki/pki add device kitchen

# 4. Deploy to the Q. --n8n binds it to the host pubkey of `laptop`.
UNOQ_HOST=arduino@kitchen.local ./install.sh \
  --device kitchen \
  --n8n laptop \
  --n8n-host n8n.example.com

# 5. In n8n, create an "Arduino UNO Q SSH Relay" credential.
#    Paste:
#      Host private key  ← pki/out/n8n/laptop/ssh_host_ed25519_key
#      User CA pubkey    ← pki/out/n8n/laptop/user_ca.pub
#    Set Device nickname to "kitchen".
```

### Subsequent Qs

Issue a fresh device cert and install — the same n8n bundle is reused:

```bash
./pki/pki add device garage
UNOQ_HOST=arduino@garage.home.lan ./install.sh \
  --device garage \
  --n8n laptop \
  --n8n-host n8n.example.com
```

### Re-pointing a device at a different n8n endpoint

Generate a new n8n bundle, then re-run `install.sh` with the new `--n8n` — no need to re-issue the device cert:

```bash
./pki/pki add n8n vps
./install.sh --device kitchen --n8n vps --n8n-host n8n.othersite.org
```

### Updating an existing relay (cert renewal, host change)

```bash
./install.sh --device kitchen --n8n laptop --n8n-host n8n.example.com
```

Rsync skips unchanged files; `docker compose up -d && restart unoq-relay-ssh` forces autossh to reload its files.

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `UNOQ_HOST` | `arduino@linucs.local` | Target Q. |
| `UNOQ_BASE` | `/home/arduino` | Base dir on the Q. The relay lands at `$UNOQ_BASE/relay-ssh/`. |
| `UNOQ_REMOTE_BIND_PORT` | `7000` | Q-side `-R` bind port. Arbitrary — not a routing key. |
| `UNOQ_AUTOSSH_POLL` | `30` | autossh poll/retry interval in seconds. Equivalent to `--retry-interval`; the CLI flag wins when both are set. Drives both the dead-tunnel detection cadence and how often a refused dial is logged. |

## Uninstall

```bash
UNOQ_HOST=arduino@kitchen.local ./uninstall.sh
```

What it does:
1. `docker compose down --rmi local` on the Q.
2. Removes `$UNOQ_BASE/relay-ssh/` (including the deployed certs and `.env`).
3. **Leaves the PKI on the PC alone.** Re-install at any time.

If you also want to decommission the cert (e.g. the Q was stolen), run `./pki/pki remove kitchen` separately. **Note**: removal is bookkeeping only — there is no revocation channel in v1, so the key holder can keep authenticating until the cert expires. For active revocation before expiry, re-bootstrap the CA and re-issue every device cert. For long-lived defaults (10 years), consider re-issuing with a shorter `--days` policy.

## Verify it's running

```bash
ssh arduino@kitchen.local 'docker compose -f /home/arduino/relay-ssh/docker-compose.yml ps'
ssh arduino@kitchen.local 'docker compose -f /home/arduino/relay-ssh/docker-compose.yml logs --tail=20 unoq-relay-ssh'
```

Expect autossh to log a single line with the connection coming up. Persistent reconnect loops indicate the n8n side rejected the auth — check the n8n logs for the matching error (wrong CA, expired cert, etc.).

In n8n: open the **Arduino UNO Q SSH Relay** credential and click **Test Connection**. A green tick proves the entire chain works (host-key pinning + user-cert auth + `tcpip-forward` accept + `forwardOut` to the router socket + `$/version` round-trip).

## Renewing certs before they expire

Default validity for device user certs is **10 years**. To pin a shorter lifetime, pass `--days N` to `pki add device`, or set `CLIENT_DAYS` per invocation (same nomenclature as [`relay-mtls/pki`](../relay-mtls/pki/)). When a cert is about to expire:

```bash
./pki/pki remove kitchen
./pki/pki add device kitchen
./install.sh --device kitchen --n8n laptop --n8n-host n8n.example.com
```

The user CA itself is long-lived — you won't touch it for most of its life. The n8n host keypair has no expiry; rotate it manually (`./pki/pki remove laptop && ./pki/pki add n8n laptop`) and then re-run `install.sh` against every Q that was bound to it.

## Troubleshooting

**`error: --device <nick> is required`** / **`--n8n <nick> is required`** / **`--n8n-host <hostname> is required`.**
All three flags are mandatory. Run `./pki/pki add device <nick>` and `./pki/pki add n8n <nick>` first.

**`error: no device bundle at …/pki/out/devices/<nick>`.**
You haven't issued a cert for that nickname yet. Re-issue with `./pki/pki add device <nick>`.

**autossh keeps reconnecting; n8n logs `Permission denied (publickey)`.**
The user cert is rejected. Most common causes:
- The user cert expired. Re-issue (`./pki remove <nick>` + `./pki add device <nick>`) and re-run `./install.sh`.
- The user CA loaded into the credential doesn't match the one that signed the cert. Re-paste `pki/out/n8n/<n8n-nick>/user_ca.pub` into the credential's **User CA public key** field.

**autossh fails with `Host key verification failed`.**
The Q has the wrong pinned host pubkey for this n8n endpoint — either the n8n endpoint's keypair was rotated since this Q was installed (`./pki add n8n` regenerated it), or the credential's host private key was swapped for a different key. Re-run `./install.sh --device <nick> --n8n <n8n-nick> --n8n-host <h>` to push the current pinned pubkey.

**autossh exits with `remote port forwarding failed`.**
n8n's auth callback rejected the cert *after* connect (e.g. the principal `tunnel` doesn't match what the credential requires). Check the n8n logs for the specific auth-failure reason.

**Two trigger nodes for the same Q both fire / one stops firing.**
The n8n-side registry routes by `keyId`, so two devices with the same KeyID would clobber each other (last-writer-wins). Don't issue two certs with the same `<nick>`; `./pki add device <nick>` refuses if the nickname is already active.

**Test Connection times out from n8n.**
Either the Q's autossh container isn't running (check `docker compose ps` on the Q), the Q's outbound network blocks the configured listen port (try a different port), or the n8n side hasn't been able to bind the listen port (check the n8n logs). The Q dials *out* — there's nothing inbound to firewall on the Q side.

**autossh logs `Connection refused` to the n8n listen port (forever).**
Expected when n8n isn't ready to accept the tunnel — the autossh container retries indefinitely, that's by design. The connection succeeds as soon as the n8n side has at least one trigger active for this device (the SSH listener is bound lazily on first activation). Two common pitfalls:
- **n8n is in Docker and the listen port isn't published.** The listener binds *inside* the container; the host port stays closed unless declared in the compose `ports:` list. Add `"<listenPort>:<listenPort>"` and recreate (`docker compose up -d`).
- **No trigger active on the n8n side.** The listener is started by the first trigger node activation. Open the workflow and toggle it active (or click "Listen for Test Event") and the autossh next retry should land.

## Logs and rotation

The autossh container retries on a fixed cadence (default 30s, settable via `--retry-interval` at install time or `AUTOSSH_POLL` in `.env`) whenever the n8n side is unreachable. That generates one log line per dial attempt — enough to fill the Q's eMMC over weeks if left unbounded.

Two knobs:
- **Cadence.** `--retry-interval 120` (or edit `AUTOSSH_POLL` in `$UNOQ_BASE/relay-ssh/.env` and `docker compose up -d`) — slower retries → less noise, slower recovery.
- **File rotation.** [`q/docker-compose.yml`](q/docker-compose.yml) caps logs at `10m × 3 files` via the `json-file` driver options.

To inspect or trim further:

```bash
# View live logs:
ssh arduino@<q-host> 'docker compose -f ~/relay-ssh/docker-compose.yml logs -f --tail=50'

# Force-truncate the current log file (rare — rotation should keep this in check):
ssh arduino@<q-host> 'docker compose -f ~/relay-ssh/docker-compose.yml down && docker compose -f ~/relay-ssh/docker-compose.yml up -d'
```

If you raise verbosity (e.g. add `-v` to autossh in `entrypoint.sh` while debugging), tighten the cap to compensate.

## SSH multiplexing

Both `install.sh` and `uninstall.sh` source [../lib/ssh-multiplex.sh](../lib/ssh-multiplex.sh), which multiplexes SSH connections so one invocation authenticates once. Password-auth users see one prompt; key-auth users see none. The control socket lingers 60 seconds after the script exits so back-to-back scripts share the connection.

## See also

- [pki/README.md](pki/README.md) — issuance in detail (single user CA, device user certs, n8n host keypairs).
- [n8n-server/README.md](n8n-server/README.md) — what the n8n host needs (listen-port reachability, credential paste flow).
- [../relay/README.md](../relay/README.md) — Variant A (plain socat) for trusted LANs.
- [../relay-mtls/README.md](../relay-mtls/README.md) — Variant C (stunnel + mTLS) for routable but untrusted networks.
- [docs/master-plan/14-relay-ssh.md](../../docs/master-plan/14-relay-ssh.md) — full design, architecture decisions, rejected alternatives.
- [docs/master-plan/12-multi-q.md](../../docs/master-plan/12-multi-q.md) — multi-Q big picture (this is one of three relay shapes).
