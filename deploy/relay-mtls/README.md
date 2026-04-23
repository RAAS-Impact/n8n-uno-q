# `deploy/relay-mtls/` — Variant C relay (stunnel + mTLS)

A TLS-terminating proxy in front of `arduino-router`'s Unix socket. Requires a client certificate signed by your home CA before it will forward a single byte. Appropriate when the LAN is untrusted and you don't want a WireGuard overlay.

See [CONTEXT.md §12.5.3](../../CONTEXT.md#1253-variant-c--stunnel--mtls) for the full design.

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
| `Dockerfile` | Alpine + stunnel. |
| `stunnel.conf` | mTLS config: `verifyPeer=yes`, requires a cert signed by your CA. |
| `docker-compose.yml` | Publishes the TCP port; bind-mounts `/var/run` for the router socket and `./certs` (read-only) for the PKI material. |
| `install.sh` | Deploy to a Q. Requires `--device <nick>`; accepts `--host <user@host>` (overrides `UNOQ_HOST`). |
| `uninstall.sh` | Remove from a Q. Accepts `--host <user@host>`. |
| `certs/` | Where the deployed cert lives on the Q. Locally only a `.gitignore`. |
| `pki/` | PC-only cert issuance tooling. **Never shipped to the Q.** See [pki/README.md](pki/README.md). |

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

**Container is up:**
```bash
ssh arduino@kitchen.local 'docker compose -f /home/arduino/relay-mtls/docker-compose.yml ps'
```

**mTLS handshake works (from any host with the client bundle):**
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
A successful handshake prints the TLS version and cipher, then hangs waiting for you to type (Ctrl-C to quit). That's proof the relay is doing mTLS correctly end-to-end.

**Test Connection in n8n:** on the credential edit screen, click *Test Connection*. Green tick = the whole chain (TLS handshake + msgpack-rpc `$/version` call) works.

## Renewing certs before they expire

Defaults: 2 years for both server and client certs. When a cert is about to expire:

```bash
./pki/pki remove kitchen
./pki/pki add device kitchen
./install.sh --device kitchen
```

The CA itself is valid for 10 years — you won't touch it for most of its life.

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
- [CONTEXT.md §12.5.3](../../CONTEXT.md#1253-variant-c--stunnel--mtls) — design rationale, security model, rejected alternatives.
