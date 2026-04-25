#!/usr/bin/env bash
# Verify a deployed plain socat relay end-to-end.
#
# Three checks, in order — first failure aborts:
#   1. Container is running on the Q (docker compose ps).
#   2. The TCP port is reachable from the PC (nc -z).
#   3. The full RPC chain works: $/version round-trip via the bridge package
#      over plaintext TCP.
#
# Usage:
#   ./check.sh [--host <user@host>] [--port <tcp-port>]
#
# Host resolution (highest to lowest priority):
#   1. --host <user@host>
#   2. UNOQ_HOST env var
#   3. arduino@linucs.local (default)
#
# Other env overrides:
#   UNOQ_BASE=/home/arduino           → base dir on the Q
#   UNOQ_RELAY_PORT=5775              → TCP port to probe
#   UNOQ_TARGET_HOST=<host>           → override the hostname used for the
#                                       PC-side TCP connect (defaults to the
#                                       host part of $HOST after stripping
#                                       <user>@). Useful when the SSH host
#                                       differs from the network-reachable one.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
# shellcheck source=../lib/ssh-multiplex.sh
source "$DEPLOY_DIR/lib/ssh-multiplex.sh"

HOST_OVERRIDE=""
PORT="${UNOQ_RELAY_PORT:-5775}"
while [ $# -gt 0 ]; do
  case "$1" in
    --host)   HOST_OVERRIDE="$2"; shift 2 ;;
    --host=*) HOST_OVERRIDE="${1#*=}"; shift ;;
    --port)   PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    -h|--help|help)
      cat <<EOF
Usage: $(basename "$0") [--host <user@host>] [--port <tcp-port>]

Verifies the plain socat relay is installed, running, and answering
\$/version end-to-end over plaintext TCP.

Options:
  --host <user@host>   Override the target host for this invocation.
                       Without it, UNOQ_HOST (env) or 'arduino@linucs.local'
                       (default) is used.
  --port <tcp-port>    TCP port to probe (default 5775, override
                       via UNOQ_RELAY_PORT env).
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $(basename "$0") [--host <user@host>] [--port <tcp-port>]" >&2
      exit 1
      ;;
  esac
done
[ -n "$HOST_OVERRIDE" ] && HOST="$HOST_OVERRIDE"

REMOTE_DIR="$REMOTE_BASE/relay"
TARGET_HOST="${UNOQ_TARGET_HOST:-${HOST#*@}}"

# --- 1. Container running? -----------------------------------------------
echo "→ [1/3] Container running on $HOST..."
RUNNING_ID="$(ssh "${SSH_OPTS[@]}" "$HOST" \
  "docker compose -f $REMOTE_DIR/docker-compose.yml ps --status running --quiet" \
  2>/dev/null || true)"
if [ -z "$RUNNING_ID" ]; then
  echo "✗ No running relay container under $REMOTE_DIR." >&2
  echo "  Run ./install.sh --host $HOST to (re)deploy." >&2
  exit 1
fi
echo "  ok ($RUNNING_ID)"

# --- 2. TCP port reachable from PC? --------------------------------------
echo "→ [2/3] TCP $TARGET_HOST:$PORT reachable from PC..."
if ! nc -z -w 5 "$TARGET_HOST" "$PORT" 2>/dev/null; then
  echo "✗ Could not open TCP $TARGET_HOST:$PORT from this host." >&2
  echo "  Possible causes: firewall on the Q, network path blocked, " >&2
  echo "  or wrong UNOQ_TARGET_HOST (current: $TARGET_HOST)." >&2
  exit 1
fi
echo "  ok"

# --- 3. \$/version round-trip via the bridge package ----------------------
echo "→ [3/3] \$/version round-trip via plaintext TCP..."
RESULT="$(PROBE_MODE=tcp PROBE_HOST="$TARGET_HOST" PROBE_PORT="$PORT" \
  node "$DEPLOY_DIR/lib/probe-version.mjs")" || PROBE_RC=$?
PROBE_RC="${PROBE_RC:-0}"
echo "  $RESULT"
if [ "$PROBE_RC" -ne 0 ]; then
  echo "✗ \$/version probe failed (rc=$PROBE_RC)." >&2
  exit 1
fi

echo
echo "✓ Plain relay healthy at $TARGET_HOST:$PORT"
