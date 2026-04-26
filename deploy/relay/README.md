# `deploy/relay/` — Variant A relay (plain socat)

A minimal socket-to-TCP bridge that exposes `arduino-router`'s Unix socket on a TCP port, so an n8n instance running on a PC can reach a Q over the LAN without SSH forwarding.

**No authentication, no encryption.** Use this only on a trusted LAN. If the network isn't trusted, use [../relay-mtls/](../relay-mtls/) (Variant C — stunnel + mTLS) instead. The two variants can't run on the same port simultaneously; pick one.

See [docs/master-plan/12-multi-q.md §12.5.1](../../docs/master-plan/12-multi-q.md#1251-variant-a--socat-only-step-1-deliverable) for the full design.

> **Migration note (existing checkouts).** Container assets moved from this directory into `q/` — `Dockerfile`, `entrypoint.sh`, `docker-compose.yml` are now under [`q/`](q/). No data loss: `git pull` performs tracked renames and leaves any untracked local files alone. **On the Q nothing changes** — the deployed layout at `$UNOQ_BASE/relay/` is identical, and re-running `./install.sh` redeploys to the same place. Only update muscle memory / custom scripts that referenced `deploy/relay/Dockerfile` etc. — those paths now need a `/q/` segment.

## What's in this directory

| File | Purpose |
|---|---|
| `q/Dockerfile` | Alpine + socat. Built locally on the Q. |
| `q/entrypoint.sh` | One-line socat invocation: TCP listen → Unix socket connect. |
| `q/docker-compose.yml` | Publishes the TCP port; bind-mounts `/var/run` so socat can reach the router's socket. |
| `install.sh` | Deploy to a Q. Accepts `--host <user@host>` to pick a target (overrides `UNOQ_HOST`). |
| `uninstall.sh` | Remove from a Q. Same `--host` option. |
| `check.sh` | Verify a deployed relay end-to-end: container running, TCP reachable, `$/version` round-trip. |

**Source layout.** Everything that runs on the Q lives under `q/`; the package root holds only PC-side scripts and docs. `install.sh` rsyncs `q/` to `$UNOQ_BASE/relay/` on the Q, so the remote layout is flat. Convention shared with [../relay-mtls/](../relay-mtls/) and the planned [../relay-ssh/](../relay-ssh/) — see [docs/master-plan/14-relay-ssh.md §14.5](../../docs/master-plan/14-relay-ssh.md).

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

The fastest way is `check.sh` — it covers all three layers in one command:

```bash
./check.sh --host arduino@kitchen.local
```

What it does:
1. SSHes to the Q and confirms `docker compose ps` reports the container running.
2. Opens TCP port 5775 (or `--port`) from the PC to verify the network path.
3. Performs an actual `$/version` MessagePack-RPC round-trip via the bridge package, so you know the full chain works (relay → router socket → MCU registry).

A successful run prints one JSON line with the router version and elapsed time, then `✓ Plain relay healthy at <host>:<port>`. A failure aborts at the first broken layer and explains what to check.

If you only want the lowest-level signal — "is the container up?" — that's:

```bash
ssh arduino@kitchen.local 'docker compose -f /home/arduino/relay/docker-compose.yml ps'
```

`docker compose ps` also reports a `(healthy)` / `(unhealthy)` flag — see [Reliability and failure modes](#reliability-and-failure-modes) below for what's checked.

## Reliability and failure modes

The relay recovers automatically from every failure mode short of "the LAN binding is wrong" (operator error). Layered defences:

| Failure | Detector | Worst-case downtime |
|---|---|---|
| Q rebooted | Docker daemon (`restart: unless-stopped` on the compose service) | Q boot time + container start |
| Container crashed | Docker daemon | ~5s container restart |
| socat process crashed | Docker daemon (it's PID 1 in the container) | Same as above |
| Listener didn't bind on startup (port in use, bad `UNOQ_RELAY_BIND`) | Docker healthcheck | 30s × 3 retries = 90s to flip `(unhealthy)` |
| arduino-router restarted (socket inode replaced) | The `/var/run` directory mount re-resolves the path on each socat fork | Per-call dial transient; subsequent dials succeed |
| n8n side disappeared mid-call (kernel panic, network blip) | The bridge layer's per-call timeout in `BridgeManager` surfaces a clear error to the workflow | Bridge `callWithOptions` timeout (default 10s) |

Variant A is plaintext per-call — there's no persistent session to keep alive, so the half-dead-session class of failures is owned by the bridge transport at the n8n end (`packages/bridge/src/transport/tcp.ts`), not by the relay.

The healthcheck verifies socat is bound to port 5775 inside the container. It does **not** verify end-to-end — for that, run `./check.sh --host …` which exercises a real `$/version` round-trip.

Logs are capped at `10 MiB × 3 files` via the `json-file` driver options in [`q/docker-compose.yml`](q/docker-compose.yml). Plenty of headroom for typical traffic; tighten if you set `socat -d -d` (verbose).

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
