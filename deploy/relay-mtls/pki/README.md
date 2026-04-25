# `pki` — mTLS certificates for the UNO Q relay, without the PKI jargon

This directory holds a small `openssl` wrapper that issues the certificates the [Variant C relay](../) needs. If you've never set up a certificate authority before, the three commands below are the entire happy path — nothing else to learn.

## Prerequisites

- `openssl` on your `PATH` (macOS: comes with the system; Linux: `apt install openssl` or equivalent).
- `bash` (the system shell on macOS and Linux).

## 5-minute quickstart

From this directory:

```bash
./pki setup                    # first time only — creates your home CA
./pki add device kitchen       # issues a server cert for your first Q
./pki add n8n laptop           # issues a client cert for your n8n instance
```

That's it. Each `add` command prints exactly which files to copy where.

## What the commands do

| Command | What it does |
|---|---|
| `./pki setup [--days N]` | Creates your home CA (the "root identity" that signs everything else). Run once. |
| `./pki add device <nick> [--hostname H] [--ip I] [--days N]` | Issues a **server** cert for a Q. Default hostname is `<nick>.local` — see [Picking the right hostname (or IP) for a device](#picking-the-right-hostname-or-ip-for-a-device) below for when to override with `--hostname` / `--ip`. |
| `./pki add n8n <nick> [--days N]` | Issues a **client** cert for an n8n instance. |
| `./pki list` | Shows all active certs and their expiry dates. |
| `./pki show <nick> [-v]` | Shows details (subject, issuer, SAN, EKU, expiry, SHA-256 fingerprint) of one cert. Use `ca` for the home CA. Add `-v` for the full `openssl x509 -text` dump. |
| `./pki remove <nick>` | Deletes the cert files and marks the entry removed in the ledger. |
| `./pki help` | Prints help. |

## Cert validity

Every cert (CA and leaf) defaults to **10 years (3650 days)**. The mTLS setup here has no CRL — revocation is bookkeeping only — so leaning on long expiry plus cheap re-bootstrap is the policy. You can override per cert via `--days N` on the CLI, or per invocation via env vars:

- `CA_DAYS` — used by `./pki setup`
- `SERVER_DAYS` — used by `./pki add device` (CA-signed *server* cert)
- `CLIENT_DAYS` — used by `./pki add n8n` (CA-signed *client* cert)

Examples:

```bash
./pki add device kitchen --days 90              # short-lived device cert
./pki add n8n laptop --days 180                 # 6-month n8n cert
SERVER_DAYS=365 ./pki add device garage         # env-var override (one-shot)
```

If you want to harden the policy and force every issuance to use a shorter lifetime, set the env var in your shell profile.

## Picking the right hostname (or IP) for a device

When you issue a device cert, you're stamping it with a name — whatever the n8n side will type into the **Host** field later. TLS requires an exact match: if n8n connects using name *X* and the cert says *Y*, the connection is rejected with `certificate verify failed`. So decide how n8n will reach the Q first, then issue a cert that matches.

### The default — `<nick>.local`

```bash
./pki add device kitchen
```

This stamps the cert with `kitchen.local`. Most home networks support this out of the box thanks to **mDNS** — a "find devices on your LAN by name" system that ships with macOS, modern Windows, and Linux (via `avahi-daemon`). You don't have to configure anything.

**Quick test:** on the machine that will run n8n, run `ping kitchen.local`. If it replies, the default will work and you can skip the flags.

### When to use `--hostname`

Use it if n8n will reach the Q by some name other than `<nick>.local`:

```bash
./pki add device kitchen --hostname kitchen.home.lan
```

Typical reasons:
- A custom DNS name you've set up on your router or home DNS (e.g. `kitchen.home.lan`, `k.mynet.example`).
- mDNS doesn't work on your network (some corporate or guest Wi-Fi networks block it; some ISPs' routers don't support it).
- You want a different nickname in the cert than in the n8n credential.

### When to use `--ip`

Use it if n8n will reach the Q by IP address:

```bash
./pki add device kitchen --ip 192.168.1.42
```

Typical reasons:
- Your network doesn't do names at all — you connect by IP.
- You're SSH-tunneling for dev, so n8n's Host field says `127.0.0.1` (note: requires `--ip 127.0.0.1` for the tunneled setup to verify).
- You want belt-and-braces: the Q always answers the same IP even if DNS is flaky.

### When to use both

If you'll sometimes connect by name and sometimes by IP, pass both. TLS will accept either when it matches the Host field:

```bash
./pki add device kitchen --hostname kitchen.home.lan --ip 192.168.1.42
```

### Decision table

| How n8n will reach the Q | What to run |
|---|---|
| `kitchen.local` (default, mDNS works) | `./pki add device kitchen` |
| `kitchen.home.lan` or another custom name | `./pki add device kitchen --hostname kitchen.home.lan` |
| `192.168.1.42` (IP only) | `./pki add device kitchen --ip 192.168.1.42` |
| Sometimes name, sometimes IP | `./pki add device kitchen --hostname kitchen.home.lan --ip 192.168.1.42` |
| `127.0.0.1` via SSH tunnel (dev) | `./pki add device kitchen --ip 127.0.0.1` |

### If you got it wrong

The symptom is n8n's **Test Connection** button showing `certificate verify failed`. The fix is to remove the bad cert and re-issue with the right flags:

```bash
./pki remove kitchen
./pki add device kitchen --hostname kitchen.local --ip 192.168.1.42
```

Then redeploy the relay on the Q so it picks up the new server cert (see the [relay-mtls install instructions](..#install)).

## What gets created

- `ca/` — your home CA. **Back this up somewhere safe.** Losing `ca.key` means every device and n8n instance needs a fresh cert.
- `out/devices/<nick>/` — bundle for a Q, containing `ca.pem`, `server.pem`, `server.key`. Copy the whole directory into the relay's `certs/` dir on the Q.
- `out/n8n/<nick>/` — bundle for an n8n instance, containing `ca.pem`, `client.pem`, `client.key`. Paste their contents into the n8n credential fields.
- `certs.tsv` — plain ledger of who got what and when. Read freely with `cat` or a spreadsheet.

Nothing in `ca/`, `out/`, or `certs.tsv` is checked into git.

## Installing a device bundle on the Q

After `./pki add device kitchen`, the script prints the exact `rsync` command. The gist:

```bash
rsync -av out/devices/kitchen/ arduino@kitchen.local:~/n8n/relay-mtls/certs/
ssh arduino@kitchen.local 'cd ~/n8n/relay-mtls && docker compose restart unoq-relay'
```

The relay container reloads its config on restart; stunnel has no hot-reload in the default Alpine build.

## Using an n8n bundle

After `./pki add n8n laptop`, open n8n, create an **Arduino UNO Q Router** credential with:

| Field | Value |
|---|---|
| Transport | TCP |
| Host | `<your Q hostname, e.g. kitchen.local>` |
| Port | `5775` |
| CA Certificate | Paste the contents of `out/n8n/laptop/ca.pem` |
| Client Certificate | Paste the contents of `out/n8n/laptop/client.pem` |
| Client Key | Paste the contents of `out/n8n/laptop/client.key` |

The **Test Connection** button will do a TLS handshake against your Q and call `$/version` — a green tick means the whole mTLS chain works.

## Renewing expired certs

Default validity for every cert (CA, device, n8n) is 10 years. When an `./pki list` row shows `(in 2 months)` or similar, re-issue the cert:

```bash
./pki remove kitchen
./pki add device kitchen
```

The CA key itself is long-lived — you won't touch it for most of the CA's life.

## What if I need to *revoke* a cert before it expires?

The setup here is deliberately minimal: stunnel with no CRL. If a client key leaks or a device is stolen, the small-fleet pragmatic answer is to **re-bootstrap the CA and re-issue every cert**:

```bash
rm -rf ca/ out/ certs.tsv
./pki setup
# re-issue every device and n8n cert
```

That's faster than operating a CRL distribution pipeline for 3 devices. If you're running enough devices for this to be painful, read the next section.

## When to graduate to `step-ca`

This wrapper is designed for 1–10 devices. It stops being comfortable when:

- You need to revoke individual certs regularly (lost laptops, compromised keys).
- You want automated renewal instead of `remove` + `add` every two years.
- You're running enough devices that `./pki list` is unmanageable.
- You need audit logs, ACLs, or provisioning automation.

At that point, [`step-ca`](https://smallstep.com/docs/step-ca/) is worth the extra install. It's a single Go binary plus a daemon; it speaks ACME, has proper revocation, and handles cert rotation well. The cert layout it produces is compatible with this relay's stunnel config — only the issuance UX changes.

## Troubleshooting

### `A CA already exists` on `./pki setup`

You already ran `setup` before. Carry on with `./pki add device` / `./pki add n8n`, or delete the `ca/` directory if you genuinely want to start from scratch (every existing cert becomes unverifiable after that).

### `A device called 'X' already exists` on `./pki add device X`

You've already issued a cert for that nickname. To re-issue:

```bash
./pki remove X
./pki add device X
```

### n8n's Test Connection says "self-signed certificate in certificate chain"

You pasted the **wrong** `ca.pem` into the credential (or forgot to paste one). The CA cert in the n8n credential must be the same one that signed the server cert on the Q — in practice, the `ca.pem` inside the same `out/n8n/<nick>/` bundle the script produced.

### n8n's Test Connection says "certificate verify failed"

A hostname mismatch: the cert was stamped with one name/IP, but n8n's **Host** field says something different. See [Picking the right hostname](#picking-the-right-hostname-or-ip-for-a-device) above for the full explanation.

Quick fix — re-issue the cert with a name/IP that matches what n8n will actually use:

```bash
./pki remove kitchen
./pki add device kitchen --hostname kitchen.local --ip 192.168.1.42
```

Or, easier if you don't want to re-issue: change the n8n credential's Host field to match whatever the cert was originally issued with (`./pki show kitchen` prints it).

### `./pki` says `openssl not found`

Install it: `brew install openssl` (macOS) or `apt install openssl` (Debian/Ubuntu).

## Implementation notes

For anyone reading the scripts:

- CA key is 4096-bit RSA, leaf keys are 2048-bit. Standard home-fleet sizing — a CA lives longer so err on the generous side; leaf keys default to 10-year validity, but you can pin a shorter lifetime per cert via `--days`.
- Server certs carry `extendedKeyUsage = serverAuth` and a `subjectAltName` matching the hostname/IP. Client certs carry `extendedKeyUsage = clientAuth` and no SAN (the server doesn't hostname-verify the client).
- Private keys are chmod'd to `0600`; certs to `0644`.
- No `openssl.cnf` customisation — each signing operation passes an ad-hoc extension file to `openssl x509 -req -extfile …`.
