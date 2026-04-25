# `deploy/relay-mtls/` — Variant C relay (stunnel + mTLS)

A TLS-terminating proxy in front of `arduino-router`'s Unix socket. Requires a client certificate signed by your home CA before it will forward a single byte. Appropriate when the LAN is untrusted and you don't want a WireGuard overlay.

See [docs/master-plan/12-multi-q.md §12.5.3](../../docs/master-plan/12-multi-q.md#1253-variant-c--stunnel--mtls) for the full design.

> **Migration note (existing checkouts).** Container assets moved from this directory into [`q/`](q/) — `Dockerfile`, `stunnel.conf`, `docker-compose.yml`, and the `certs/` placeholder. **Your PKI is safe:** the [`pki/`](pki/) tree (CA private key, issued bundles, `certs.tsv`, `revoked_serials`) stayed at the package root and is untouched. **Your deployed cert bundle on the Q is safe:** `install.sh` and `sync.sh` keep `--exclude certs`, so `$UNOQ_BASE/relay-mtls/certs/` is never wiped by rsync `--delete`. **No data loss anywhere** — `git pull` performs tracked renames and leaves untracked local files alone (if you'd ever placed PEMs in the old `certs/` dir manually, they'd survive but be orphaned — not harmful, just unused). Only update muscle memory / custom scripts that referenced `deploy/relay-mtls/Dockerfile` etc. — those paths now need a `/q/` segment.

## When to use this vs Variant A

| | Use [Variant A](../relay/) | Use Variant C (this) |
|---|---|---|
| Trusted home LAN | ✓ | overkill |
| Untrusted or shared network | risky | ✓ |
| You want encryption in transit | no | ✓ |
| You want per-client identity (revocable) | no | ✓ |
| Simplest possible setup | ✓ | requires PKI |

## What's in this directory

| File / dir | Purpose |
|---|---|
| `q/Dockerfile` | Alpine + stunnel. |
| `q/stunnel.conf` | mTLS config: `verifyPeer=yes`, requires a cert signed by your CA. |
| `q/docker-compose.yml` | Publishes the TCP port; bind-mounts `/var/run` for the router socket and `./certs` (read-only) for the PKI material. |
| `q/certs/` | PC-side placeholder (only a `.gitignore`); the real cert bundle lands at `$UNOQ_BASE/relay-mtls/certs/` on the Q after install. |
| `install.sh` | Deploy to a Q. Requires `--device <nick>`; accepts `--host <user@host>` (overrides `UNOQ_HOST`). |
| `uninstall.sh` | Remove from a Q. Accepts `--host <user@host>`. |
| `check.sh` | Verify a deployed relay end-to-end: container running, TCP reachable, mTLS handshake + `$/version` round-trip. Takes the same `--device <nick>` you passed to `install.sh`; auto-picks an n8n client bundle (use `--n8n <nick>` if you have several). |
| `pki/` | PC-only cert issuance tooling. **Never shipped to the Q.** See [pki/README.md](pki/README.md). |

**Source layout.** Everything that runs on the Q lives under `q/`; the package root holds only PC-side scripts, docs, and the `pki/` tooling. `install.sh` rsyncs `q/` to `$UNOQ_BASE/relay-mtls/` on the Q (the cert bundle is pushed separately into `relay-mtls/certs/`). Convention shared with [../relay/](../relay/) and the planned [../relay-ssh/](../relay-ssh/) — see [docs/master-plan/14-relay-ssh.md §14.5](../../docs/master-plan/14-relay-ssh.md).

## End-to-end workflow

```
┌─ PC ──────────────────────────────┐         ┌─ Q ──────────────────────┐
│                                   │         │                          │
│  ./pki setup                      │         │                          │
│  ./pki add device kitchen         │         │                          │
│  ./pki add n8n laptop             │         │                          │
│                                   │  ssh +  │                          │
│  ./install.sh --device kitchen  ──┼─rsync──►│  /home/arduino/relay-mtls│
│                                   │         │    docker compose up -d  │
│                                   │         │                          │
│  n8n credential ← out/n8n/laptop/ │         │                          │
└───────────────────────────────────┘         └──────────────────────────┘
```

The PKI lives entirely on the PC. `install.sh` copies the device's server cert bundle to the Q (everything under `pki/out/devices/<nick>/`), and you paste the n8n client bundle (`pki/out/n8n/<nick>/`) into the n8n credential. The CA private key never leaves the PC.

## Install

### First time

```bash
# 1. Create your home CA (once, ever).
./pki/pki setup

# 2. Issue a server cert for this Q.
./pki/pki add device kitchen

# 3. Issue a client cert for your n8n instance.
./pki/pki add n8n laptop

# 4. Deploy the relay + device cert to the Q.
UNOQ_HOST=arduino@kitchen.local ./install.sh --device kitchen

# 5. In n8n, create an "Arduino UNO Q Router" credential.
#    Paste the files from pki/out/n8n/laptop/ into the three TLS fields.
```

### Subsequent Qs

Issue a new device cert and install:

```bash
./pki/pki add device garage --hostname garage.home.lan --ip 192.168.1.42
UNOQ_HOST=arduino@garage.home.lan ./install.sh --device garage
```

You can re-use the same n8n client cert across all your Qs — `add n8n` is per n8n instance, not per Q.

### Updating an existing relay

Re-run `install.sh` with the same `--device`:

```bash
./install.sh --device kitchen
```

Rsync skips unchanged files; `docker compose up -d && restart unoq-relay` forces stunnel to re-read the cert files (it has no hot-reload).

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `UNOQ_HOST` | `arduino@linucs.local` | Target Q. |
| `UNOQ_BASE` | `/home/arduino` | Base dir on the Q. The relay lands at `$UNOQ_BASE/relay-mtls/`. |
| `UNOQ_RELAY_PORT` | `5775` | Shown in post-install hints only. |

## Uninstall

```bash
UNOQ_HOST=arduino@kitchen.local ./uninstall.sh
```

What it does:
1. `docker compose down --rmi local` on the Q.
2. Removes `$UNOQ_BASE/relay-mtls/` (including the deployed certs).
3. **Leaves the PKI on the PC alone.** Re-install with `./install.sh --device kitchen` any time.

If you also want to decommission the cert (e.g. the Q was stolen), run `./pki/pki remove kitchen` separately.

## Verify it's running

The fastest way is `check.sh` — it covers all three layers in one command:

```bash
./check.sh --device kitchen --host arduino@kitchen.local
```

What it does:
1. SSHes to the Q and confirms `docker compose ps` reports the container running.
2. Opens TCP port 5775 (or `--port`) from the PC to verify the network path.
3. Performs an actual mTLS handshake + `$/version` MessagePack-RPC round-trip via the bridge package — so a green check proves the entire chain works (TLS chain validation, certificate identity, relay → router socket → MCU registry).

The `--device <nick>` flag matches the one you passed to `install.sh`; the script confirms that the device bundle exists locally and uses an auto-discovered n8n client bundle from `pki/out/n8n/` for the handshake. Pass `--n8n <nick>` if you have multiple n8n bundles issued and want to pick a specific one.

A successful run prints one JSON line with the router version and elapsed time, then `✓ mTLS relay healthy at <host>:<port> (device='<nick>', client='<nick>')`. A failure aborts at the first broken layer and surfaces a concrete cause (e.g. cert SAN mismatch).

Lower-level alternatives if you want to isolate a layer:

**Container is up:**
```bash
ssh arduino@kitchen.local 'docker compose -f /home/arduino/relay-mtls/docker-compose.yml ps'
```

**mTLS handshake only (no MessagePack-RPC):**
```bash
# With pki/out/n8n/laptop/ on this host.
openssl s_client \
  -connect kitchen.local:5775 \
  -CAfile pki/out/n8n/laptop/ca.pem \
  -cert   pki/out/n8n/laptop/client.pem \
  -key    pki/out/n8n/laptop/client.key \
  -verify_return_error \
  -quiet
```
A successful handshake prints the TLS version and cipher, then hangs waiting for you to type (Ctrl-C to quit).

**Test Connection in n8n:** on the credential edit screen, click *Test Connection*. Green tick = the whole chain (TLS handshake + `$/version`) works.

## Renewing certs before they expire

Default validity for every cert (CA, server, client) is **10 years**. To pin a shorter lifetime, pass `--days N` to `pki add device|n8n`, or set `SERVER_DAYS` / `CLIENT_DAYS` / `CA_DAYS` per invocation. When a cert is about to expire:

```bash
./pki/pki remove kitchen
./pki/pki add device kitchen
./install.sh --device kitchen
```

## Troubleshooting

**`error: --device <nickname> is required`.**
`install.sh` needs the nickname of a cert bundle. Run `./pki/pki add device <nick>` first.

**`error: no cert bundle at …/pki/out/devices/<nick>`.**
You haven't issued a cert for that nickname yet, or the output directory was deleted. Re-issue with `./pki/pki add device <nick>`.

**n8n's *Test Connection* says `certificate verify failed`.**
Usually a hostname mismatch: the Q's server cert was issued for `kitchen.local` but the credential's **Host** field says `192.168.1.42`. Either change the credential to match the SAN, or re-issue the device cert with an IP SAN:
```bash
./pki/pki remove kitchen
./pki/pki add device kitchen --hostname kitchen.local --ip 192.168.1.42
./install.sh --device kitchen
```

**`self-signed certificate in certificate chain`.**
You pasted the wrong `ca.pem` into the credential. It must be the same CA that signed the server cert — in practice, the `ca.pem` inside the same `pki/out/n8n/<nick>/` bundle your script produced.

**`peer did not return a certificate`.**
n8n is connecting without presenting a client cert, or presenting one not signed by your CA. Re-check the *Client Certificate* and *Client Key* fields — both must be from the same `pki/out/n8n/<nick>/` bundle.

**`port is already allocated`.**
Variant A is running on the same port. Uninstall it (`../relay/uninstall.sh`) or pick a different port for one of them.

**Container is running but connections time out.**
Firewall on the Q, or network path between PC and Q is blocked. Test locally on the Q:
```bash
ssh arduino@kitchen.local 'nc -zv 127.0.0.1 5775'
```

**You lost `pki/ca/ca.key`.**
Every cert becomes unverifiable. Re-bootstrap: `rm -rf pki/ca pki/out pki/certs.tsv && ./pki/pki setup && …` (then re-issue and re-install every device and n8n cert). For small fleets that's faster than operating a CRL; see [pki/README.md](pki/README.md#when-to-graduate-to-step-ca) for when to graduate to step-ca.

## SSH multiplexing

Both `install.sh` and `uninstall.sh` source [../lib/ssh-multiplex.sh](../lib/ssh-multiplex.sh), which multiplexes SSH connections so one invocation authenticates once. Password-auth users see one prompt; key-auth users see none. The control socket lingers 60 seconds after the script exits so back-to-back scripts share the connection.

## See also

- [pki/README.md](pki/README.md) — cert issuance in detail, including when to migrate to `step-ca`.
- [../relay/README.md](../relay/README.md) — Variant A (plain socat) for trusted LANs.
- [../sync.sh](../sync.sh) — n8n custom-nodes sync; syncs the relay's compose files as a side effect but does **not** start the container.
- [docs/master-plan/12-multi-q.md §12.5.3](../../docs/master-plan/12-multi-q.md#1253-variant-c--stunnel--mtls) — design rationale, security model, rejected alternatives.
