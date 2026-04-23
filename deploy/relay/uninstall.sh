#!/usr/bin/env bash
# Uninstall the plain socat relay from a Q.
#
# Stops and removes the container, deletes the locally-built image, and
# removes $REMOTE_BASE/relay/ on the host. Leaves arduino-router untouched
# — only the relay container is affected.
#
# Usage:
#   ./uninstall.sh [--host <user@host>]
#
# Host resolution (highest to lowest priority):
#   1. --host <user@host>
#   2. UNOQ_HOST env var
#   3. arduino@linucs.local (default)
#
# Other env overrides:
#   UNOQ_BASE=/home/arduino
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=../lib/ssh-multiplex.sh
source "$DEPLOY_DIR/lib/ssh-multiplex.sh"

HOST_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --host)   HOST_OVERRIDE="$2"; shift 2 ;;
    --host=*) HOST_OVERRIDE="${1#*=}"; shift ;;
    -h|--help|help)
      cat <<EOF
Usage: $(basename "$0") [--host <user@host>]

Removes the plain socat relay from the target Q.

Options:
  --host <user@host>   Override the target host for this invocation.
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $(basename "$0") [--host <user@host>]" >&2
      exit 1
      ;;
  esac
done
[ -n "$HOST_OVERRIDE" ] && HOST="$HOST_OVERRIDE"

REMOTE_DIR="$REMOTE_BASE/relay"

echo "Uninstalling plain socat relay from $HOST..."

# `|| true` on the compose-down step: tolerate the case where the compose
# file is missing or the container is already gone — we still want to wipe
# the remote dir regardless.
ssh "${SSH_OPTS[@]}" "$HOST" "
  if [ -f $REMOTE_DIR/docker-compose.yml ]; then
    cd $REMOTE_DIR && docker compose down --rmi local || true
  fi
  rm -rf $REMOTE_DIR
"

echo "✓ Plain socat relay removed from $HOST"
