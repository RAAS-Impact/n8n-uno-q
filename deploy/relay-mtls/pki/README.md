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
| `./pki setup` | Creates your home CA (the "root identity" that signs everything else). Run once. |
| `./pki add device <nick> [--hostname H] [--ip I]` | Issues a **server** cert for a Q. By default binds to `<nick>.local` (mDNS); pass `--hostname`/`--ip` if your LAN needs something different. |
| `./pki add n8n <nick>` | Issues a **client** cert for an n8n instance. |
| `./pki list` | Shows all active certs and their expiry dates. |
| `./pki remove <nick>` | Deletes the cert files and marks the entry removed in the ledger. |
| `./pki help` | Prints help. |

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

Default validities: CA 10 years, device + n8n certs 2 years each. When an `./pki list` row shows `(in 2 months)` or similar, re-issue the cert:

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

Usually a hostname mismatch: the Q's server cert was issued with `--hostname kitchen.local` but the credential's **Host** field says `192.168.1.42`. Either change the credential to match the SAN, or re-issue the device cert with an IP SAN:

```bash
./pki remove kitchen
./pki add device kitchen --hostname kitchen.local --ip 192.168.1.42
```

### `./pki` says `openssl not found`

Install it: `brew install openssl` (macOS) or `apt install openssl` (Debian/Ubuntu).

## Implementation notes

For anyone reading the scripts:

- CA key is 4096-bit RSA, leaf keys are 2048-bit. Standard home-fleet sizing — a CA lives longer so err on the generous side; leaf cert keys rotate every 2 years so 2048 is plenty.
- Server certs carry `extendedKeyUsage = serverAuth` and a `subjectAltName` matching the hostname/IP. Client certs carry `extendedKeyUsage = clientAuth` and no SAN (the server doesn't hostname-verify the client).
- Private keys are chmod'd to `0600`; certs to `0644`.
- No `openssl.cnf` customisation — each signing operation passes an ad-hoc extension file to `openssl x509 -req -extfile …`.
