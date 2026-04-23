#!/usr/bin/env bash
# Uninstall Variant A relay from a Q.
#
# Stops and removes the container, deletes the locally-built image, and
# removes $REMOTE_BASE/relay/ on the host. Leaves arduino-router untouched
# — only the relay container is affected.
#
# Env overrides:
#   UNOQ_HOST=arduino@garage.local
#   UNOQ_BASE=/home/arduino
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=../lib/ssh-multiplex.sh
source "$DEPLOY_DIR/lib/ssh-multiplex.sh"

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
