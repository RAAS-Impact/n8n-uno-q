# `n8n-server/` — what the n8n host needs

Unlike Variant A and Variant C, the n8n side of the reverse-SSH relay is **not a separate container**. The SSH server runs inside the n8n process itself — `SshServer.getInstance()`, a singleton stashed on `globalThis` (same pattern as `BridgeManager`). There's no `docker compose` to run on the n8n host: the credential carries the host private key + user CA + listen port, and n8n boots the listener on demand the first time a credential is used.

That means **everything you need to do on the n8n host is paste a credential and make sure a TCP port is reachable.** No container, no systemd unit, no `sshd_config` edits.

> **Status:** as of 2026-04-25 the entire stack is shipped — Commit 1, 2, and 3 of [§14.8](../../../docs/master-plan/14-relay-ssh.md). The `SshServer` runtime and the `UnoQSshApi` credential live in [packages/n8n-nodes](../../../packages/n8n-nodes/) (covered by 18 unit tests).

## Prerequisite: a reachable listen port

Pick a TCP port — `2222` by default. The Q's autossh dials this port from wherever it sits, so it must be **reachable from the Q** (typically from the Internet, since that's the whole point of the variant).

How to make it reachable depends on where n8n runs:

| n8n is hosted on... | What you need |
|---|---|
| A public VPS with a static IP | Open `2222` in your firewall; the n8n process binds and listens. |
| A home network behind your own router | Forward `2222` from the router's WAN port to the LAN IP of the n8n host. |
| A platform with built-in TCP ingress (e.g. Fly.io, Railway) | Add a TCP route to port `2222`. |
| Cloudflare Tunnel / Tailscale Funnel / similar | Route `2222` through the tunnel; the Q dials the public hostname. |

Whichever option you pick, the **hostname** you pass to `install.sh --n8n-host <h>` must be the address the Q-side autossh will dial. Unlike a CA-based design, there is no cert principal to match — host trust is established by pinning the bare host pubkey. So you can use any hostname/IP that resolves and routes to your listener; you can even pin the same key under multiple hostnames by hand-editing `known_hosts` post-install.

## Trust model — host side: pinning, not certs

`ssh2` v1.17 does not advertise OpenSSH host certificates (verified empirically 2026-04-25; see [master-plan §14.2](../../../docs/master-plan/14-relay-ssh.md)). So the device side cannot use `@cert-authority` known_hosts entries. Instead:

- `./pki/pki add n8n <nick>` generates a bare host keypair (no cert).
- `install.sh --n8n <nick>` copies the pubkey portion to the Q and writes it as a normal `known_hosts` line.
- Each device trusts *exactly* the pubkey it was installed with, and nothing else.

**Operational consequence**: rotating the host keypair (`./pki remove <nick>` + `./pki add n8n <nick>`) breaks every device that was pinned to the old pubkey, until you re-run `install.sh` on each one. For a small fleet that's acceptable; for a large one, you script it.

## The credential paste flow

After running `./pki/pki add n8n laptop`, the bundle at `deploy/relay-ssh/pki/out/n8n/laptop/` contains three files. Two paste into the n8n credential.

### Field reference (preview — pending Commit 3)

| Field | Source |
|---|---|
| Device nickname | The `<nick>` you used with `./pki/pki add device <nick>`. The same string ends up in the cert's KeyID and is the routing key on the n8n side. |
| Listen address | `0.0.0.0` to bind on every interface (default). `127.0.0.1` if you front the SSH listener with a reverse proxy. |
| Listen port | The TCP port made reachable per the table above. Default `2222`. |
| Host private key | Paste the contents of `pki/out/n8n/<nick>/ssh_host_ed25519_key`. This is the bare host key the SSH server presents during KEX. **No host certificate** — by design. |
| User CA public key | Paste the contents of `pki/out/n8n/<nick>/user_ca.pub`. |
| Required principal *(Advanced)* | `tunnel` by default. Defense-in-depth check on top of the KeyID-based routing. |
| Connect timeout (ms) *(Advanced)* | How long `connect(deviceNick)` waits for the Q to be present in the registry. Default `10000`. |
| Idle disconnect (s) *(Advanced)* | Disconnect a Q's SSH session after this many seconds of no traffic. `0` = never. Default `0`. |

There is **no "Host certificate" field** and **no "Revoked serials" field** in v1. Both are intentionally out of scope (host certs because ssh2 doesn't support them; revocation because it's symmetric with [`relay-mtls`](../../relay-mtls/) which has no CRL either).

The multiline fields (host key, user CA) are deliberately **not** password-masked — n8n's masked multiline textarea reformats whitespace in a way that breaks PEM/SSH parsers. See [packages/n8n-nodes/src/credentials/UnoQRouterApi.credentials.ts](../../../packages/n8n-nodes/src/credentials/UnoQRouterApi.credentials.ts) for the same rule applied to mTLS PEMs and the bug history behind it.

### One credential per device, one host keypair per endpoint

Every Q gets its own credential, keyed by **Device nickname**. The host private key + user CA are the same across all credentials that share the same n8n endpoint (because `install.sh --n8n <nick>` binds Qs to a specific n8n endpoint). All credentials sharing those values use the singleton `SshServer` inside n8n — the per-device split is just a UX-level pointer, not a separate listener per device.

If you run **multiple n8n endpoints** (e.g. dev + prod) on the same listen port, each endpoint has its own host keypair (`./pki add n8n laptop`, `./pki add n8n prod`); pasting `prod`'s bundle into one credential and `laptop`'s into another would make those credentials boot two separate ssh2.Server singletons — but a single n8n process can only bind one port. In practice: one n8n endpoint per n8n instance.

## Verifying everything's wired

After install, the **Test Connection** button on the credential page should:

1. Boot (or reuse) the singleton `SshServer` on the configured listen port.
2. Look up the **Device nickname** in the in-process registry.
3. If found: `forwardOut` through the SSH channel and call `$/version` on the router. Echo the result.
4. If not found: report "device not currently connected" — the Q's autossh hasn't established the tunnel yet (or the cert was rejected).

If the Q-side container is up and the cert chain is valid but the device still doesn't show up, check the n8n logs for the auth-failure reason (wrong CA, expired cert, missing principal, missing `permit-port-forwarding` extension).

## See also

- [../README.md](../README.md) — package-level intro and end-to-end workflow.
- [../pki/README.md](../pki/README.md) — issuance in detail (single user CA, device user certs, n8n host keypairs).
- [docs/master-plan/14-relay-ssh.md §14.6](../../../docs/master-plan/14-relay-ssh.md) — full credential field reference and `Test Connection` semantics.
- [docs/master-plan/14-relay-ssh.md §14.9](../../../docs/master-plan/14-relay-ssh.md) — open items including queue-mode singleton scope.
