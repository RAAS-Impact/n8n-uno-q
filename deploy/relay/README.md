# `deploy/relay/` — Variant A relay (plain socat)

A minimal socket-to-TCP bridge that exposes `arduino-router`'s Unix socket on a TCP port, so an n8n instance running on a PC can reach a Q over the LAN without SSH forwarding.

**No authentication, no encryption.** Use this only on a trusted LAN. If the network isn't trusted, use [../relay-mtls/](../relay-mtls/) (Variant C — stunnel + mTLS) instead. The two variants can't run on the same port simultaneously; pick one.

See [docs/master-plan/12-multi-q.md §12.5.1](../../docs/master-plan/12-multi-q.md#1251-variant-a--socat-only-step-1-deliverable) for the full design.

## What's in this directory

| File | Purpose |
|---|---|
| `Dockerfile` | Alpine + socat. Built locally on the Q. |
| `entrypoint.sh` | One-line socat invocation: TCP listen → Unix socket connect. |
| `docker-compose.yml` | Publishes the TCP port; bind-mounts `/var/run` so socat can reach the router's socket. |
| `install.sh` | Deploy to a Q. Accepts `--host <user@host>` to pick a target (overrides `UNOQ_HOST`). |
| `uninstall.sh` | Remove from a Q. Same `--host` option. |

## Install

From the repo root or from this directory:

```bash
./install.sh --host arduino@kitchen.local
```

Or, if you've set `UNOQ_HOST` once in your environment:

```bash
./install.sh
```

What it does:

1. Establishes an SSH connection to the Q (one password prompt if you use password auth; zero if you have keys set up — see [SSH multiplexing](#ssh-multiplexing)).
2. Rsyncs the relay files to `/home/arduino/relay/` on the Q.
3. Runs `docker compose up -d` over SSH.
4. Prints verification commands and n8n credential hints.

Re-running is safe — rsync skips unchanged files, `docker compose up -d` is idempotent.

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `UNOQ_HOST` | `arduino@linucs.local` | `<user>@<host>` — the Q to deploy to. |
| `UNOQ_BASE` | `/home/arduino` | Base directory on the Q. The relay lands at `$UNOQ_BASE/relay/`. |
| `UNOQ_RELAY_PORT` | `5775` | Shown in the post-install hints only — the actual port binding is controlled by `.env` or the compose file on the Q. |

### After install

Two ways to use the relay from n8n:

**SSH-forwarded (dev loop, local n8n):**
```bash
ssh -L 5775:localhost:5775 arduino@kitchen.local
# In another terminal, run n8n on the PC. In the credential:
#   Transport: TCP
#   Host:      127.0.0.1
#   Port:      5775
```

**Direct LAN (n8n on a different host):**
```
Transport: TCP
Host:      kitchen.local    (or whatever UNOQ_HOST resolved to)
Port:      5775
```

## Uninstall

```bash
UNOQ_HOST=arduino@kitchen.local ./uninstall.sh
```

What it does:
1. `docker compose down --rmi local` on the Q (stops the container, removes the locally-built image).
2. Removes `$UNOQ_BASE/relay/`.
3. Leaves `arduino-router` and everything else untouched.

## Verify it's running

```bash
ssh arduino@kitchen.local 'docker compose -f /home/arduino/relay/docker-compose.yml ps'
```

Expected state: one container named `unoq-relay`, `Up`. If you want to exercise the RPC path end-to-end before wiring n8n, see [packages/bridge/README.md](../../packages/bridge/README.md) and point the test scripts at the TCP endpoint.

## Troubleshooting

**`Error response from daemon: driver failed programming external connectivity […] address already in use`.**
Another service on the Q is holding port 5775. If you've also installed Variant C, the two collide — pick one variant per Q, or change `UNOQ_RELAY_PORT` for one of them.

**`connection refused` from the PC even though `install.sh` succeeded.**
Ninety percent of the time: the Q's firewall is blocking the port, or your PC and the Q aren't on the same network. Test from the Q itself:
```bash
ssh arduino@kitchen.local 'nc -zv 127.0.0.1 5775'
```
If that works, the socat side is fine and the problem is network path.

**`Cannot connect to the Docker daemon`.**
Your SSH user isn't in the `docker` group. On the stock UNO Q the `arduino` user already is — this usually means you're SSH'd in as a different user. Check with `groups`.

## SSH multiplexing

Both `install.sh` and `uninstall.sh` source [../lib/ssh-multiplex.sh](../lib/ssh-multiplex.sh), which sets up SSH connection multiplexing so one script invocation = one authentication. Password-auth users see exactly one prompt per script run (instead of several); key-auth users see none. The control socket lingers 60 seconds after the script exits so back-to-back scripts share the same authenticated connection.

## See also

- [../relay-mtls/README.md](../relay-mtls/README.md) — Variant C (stunnel + mTLS). Use this when the LAN is untrusted.
- [../sync.sh](../sync.sh) — syncs the n8n container's custom-nodes bundle; syncs the compose files for *both* relays as a side effect but does **not** start them.
- [docs/master-plan/12-multi-q.md §12.5.1](../../docs/master-plan/12-multi-q.md#1251-variant-a--socat-only-step-1-deliverable) — design rationale, rejected alternatives.
