# `pki` — SSH user certs and n8n host keypairs for the reverse-SSH relay

This directory holds a small `ssh-keygen` wrapper that issues the auth material the [reverse-SSH relay](../) needs. If you've used [../../relay-mtls/pki/](../../relay-mtls/pki/) the muscle memory carries over verbatim — same commands, same ledger shape.

## Prerequisites

- `ssh-keygen` on your `PATH`. macOS has it preinstalled. Debian/Ubuntu: `apt install openssh-client`.
- `bash` (the system shell on macOS and Linux).

## 5-minute quickstart

From this directory:

```bash
./pki setup                  # first time only — creates the user CA
./pki add n8n laptop         # generate the host keypair for the n8n endpoint
./pki add device kitchen     # user cert for your first Q
```

The relay's [install.sh](../install.sh) consumes both bundles when you deploy to a Q.

## What the commands do

| Command | What it does |
|---|---|
| `./pki setup` | Creates the **user CA** (signs device user certs). Run once. |
| `./pki add device <nick> [--days N]` | Issues a **user cert** for a Q. Principal=`tunnel`, KeyID=`<nick>` (the routing key on the n8n side), valid 10 years by default, only `permit-port-forwarding` enabled. |
| `./pki add n8n <nick>` | Generates a **host keypair** for an n8n SSH endpoint. No cert (see "Why no host CA" below). |
| `./pki list` | Shows all active material and (for device certs) their expiry dates. |
| `./pki show <nick> [-v]` | Shows details of one cert/keypair. Use `user_ca` for the CA pubkey. Add `-v` for the raw body. |
| `./pki remove <nick>` | Decommissions: deletes the bundle on disk, marks the ledger row removed. **Bookkeeping only** — no revocation channel in v1. |
| `./pki help` | Prints help. |

## Why no host CA

The original design had two CAs: user CA for device certs, host CA for n8n host certs. Empirical verification (2026-04-25) showed that **`ssh2` v1.17 does not advertise host certs** — the `cert` field on `hostKeys[*]` is silently ignored, so any `@cert-authority` line in the device's `known_hosts` would never match.

Switching to **host-key fingerprint pinning** removes the host CA entirely:

- `./pki add n8n <nick>` generates a plain ed25519 keypair, no cert.
- `install.sh --n8n <nick>` ships the *bare host pubkey* to the device, which writes it as a regular `known_hosts` line.
- The device verifies the n8n endpoint by exact-match of the pinned pubkey.

**Trade-off**: rotating the n8n endpoint's host key (`./pki remove <nick>` then `./pki add n8n <nick>`) means re-running `install.sh` on every Q bound to that endpoint. For small fleets that's acceptable; for large ones, options are documented in [../README.md](../README.md) "Trust model" and [docs/master-plan/14-relay-ssh.md §14.2](../../../docs/master-plan/14-relay-ssh.md).

The user-CA part is unchanged: device certs are signed by `user_ca`, n8n verifies them by manually parsing the OpenSSH cert wire format.

## What gets created

```
pki/
├── ca/
│   ├── user_ca       (private — back this up!)
│   └── user_ca.pub
├── out/
│   ├── devices/<nick>/
│   │   ├── id_ed25519              (private — copied to the Q at install time)
│   │   ├── id_ed25519.pub          (raw pubkey — not used past signing)
│   │   └── id_ed25519-cert.pub     (user cert)
│   └── n8n/<nick>/
│       ├── ssh_host_ed25519_key            (private — pasted into the n8n credential)
│       ├── ssh_host_ed25519_key.pub        (host pubkey — pinned by every device bound to this endpoint)
│       └── user_ca.pub                     (n8n trusts user-certs signed by this)
└── certs.tsv         (ledger — readable in any spreadsheet)
```

Nothing under `ca/`, `out/`, or `certs.tsv` is checked into git.

## Cert validity

Device user certs default to **10 years (3650 days)**. Override per-cert via `--days N` on the CLI, or per invocation via the `CLIENT_DAYS` env var:

```bash
./pki add device kitchen --days 90              # short-lived device cert
CLIENT_DAYS=180 ./pki add device garage         # env-var override (one-shot)
```

`SERVER_DAYS` does NOT exist in this package — there is no host *cert* (only a bare host *keypair*), so there's no server-side validity to bound. Naming for `CLIENT_DAYS` mirrors [`deploy/relay-mtls/pki`](../../relay-mtls/pki/) so the muscle memory carries over.

## Identification by KeyID

The `-I <nick>` flag stamps `<nick>` into the cert's `Key ID` field. The n8n side reads it during auth and uses it as the routing key (`registry.get(<nick>)`). So:

- The same `<nick>` you pass to `./pki add device` is also what you put into the n8n credential's **Device nickname** field.
- `./pki add device kitchen` followed by `./pki add device kitchen` is rejected — issuing two certs with the same KeyID would make registry routing last-writer-wins. Run `./pki remove kitchen` first if you need to re-issue.
- A compromised device cannot impersonate another: the CA never signs a cert with someone else's KeyID. Routing is **only** by KeyID — the SSH listen port is irrelevant.

See [docs/master-plan/14-relay-ssh.md §14.4](../../../docs/master-plan/14-relay-ssh.md) for the architecture.

## Renewing certs before they expire

When `./pki list` shows a cert nearing expiry, re-issue:

```bash
./pki remove kitchen
./pki add device kitchen
../install.sh --device kitchen --n8n <n8n-nick> --n8n-host <hostname>
```

The user CA itself is indefinite (OpenSSH CA keys don't carry validity — only the certs they sign do).

## Rotating the n8n endpoint's host key

```bash
./pki remove laptop
./pki add n8n laptop
# then re-run install.sh on every Q previously bound to 'laptop'
```

This rotation is the cost of the host-key-pinning trust model: every device's `known_hosts` needs the new pubkey or it will fail with `Host key verification failed`.

## Revoking a cert before it expires

There is no revocation channel in v1: `./pki remove <nick>` is bookkeeping only — same posture as [`deploy/relay-mtls/pki`](../../relay-mtls/pki/). The key holder can keep authenticating until the cert expires.

If you need active revocation before expiry, re-bootstrap and re-issue every device cert:

```bash
rm -rf ca/ out/ certs.tsv
./pki setup
# then re-issue every device and n8n keypair
```

For very long-lived certs (default 10 years) consider issuing with a shorter `--days` so the natural-expiry safety net kicks in sooner.

## Troubleshooting

### `A user CA already exists` on `./pki setup`

You already ran `setup`. Carry on with `./pki add ...` — or delete the `ca/` directory if you genuinely want to start from scratch (every existing device cert becomes unverifiable after that).

### `A device called 'X' already exists` on `./pki add device X`

A cert for that nickname is already active. Re-issue:

```bash
./pki remove X
./pki add device X
```

### Devices fail with `Host key verification failed` after re-running `pki add n8n`

`./pki add n8n` rotates the host keypair. Every Q already bound to that n8n endpoint has the previous pubkey pinned in its `known_hosts`. Re-run `install.sh` on every such Q to push the new pubkey.

## Implementation notes

For anyone reading the scripts:

- Keys are ed25519 — no passphrase prompts during issuance, and the resulting cert/pubkey files are tiny (~100-400 bytes).
- User certs use `-O clear -O permit-port-forwarding` — OpenSSH's default permission set (PTY, X11, agent, port-forwarding, user-rc) is stripped first, then only port-forwarding is granted back. The cert can do nothing else, even if a Q is compromised.
- n8n entries are bare keypairs; no `ssh-keygen -s ...` step. The host keypair is what the embedded `ssh2.Server` presents during KEX, exactly as-is.
- Private keys are chmod'd to `0600`; pubkeys/certs to `0644`.
