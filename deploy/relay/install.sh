#!/usr/bin/env bash
# Install Variant A (plain socat) relay on a Q.
#
# Rsyncs the relay files to $REMOTE_BASE/relay/ on the host and runs
# `docker compose up -d`. Idempotent — safe to re-run to update a live relay.
#
# Env overrides:
#   UNOQ_HOST=arduino@garage.local   → target host (default arduino@linucs.local)
#   UNOQ_BASE=/home/arduino          → base dir on the Q
#
# No cert material is involved — Variant A is plaintext TCP on the LAN.
# Use Variant C (deploy/relay-mtls) when the LAN isn't trusted.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=../lib/ssh-multiplex.sh
source "$DEPLOY_DIR/lib/ssh-multiplex.sh"

REMOTE_DIR="$REMOTE_BASE/relay"

echo "Installing plain socat relay on $HOST..."

# First ssh establishes the ControlMaster — one prompt for password-auth users.
ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p $REMOTE_DIR"

# Sync relay files. Exclude the installer scripts themselves — they're for PC
# use only, and leaving them out of the remote dir prevents drift if the user
# ever edits them on the Q by accident.
rsync -av --delete -e "$SSH_CMD" \
  --exclude install.sh --exclude uninstall.sh \
  "$SCRIPT_DIR/" "$HOST:$REMOTE_DIR/"

ssh "${SSH_OPTS[@]}" "$HOST" "cd $REMOTE_DIR && docker compose up -d"

PORT="${UNOQ_RELAY_PORT:-5775}"
cat <<EOF

✓ Plain socat relay running on $HOST

Verify:
  ssh $HOST 'docker compose -f $REMOTE_DIR/docker-compose.yml ps'

Use from a PC n8n instance:
  # SSH-forward the port for dev:
  ssh -L $PORT:localhost:$PORT $HOST
  # Then create an Arduino UNO Q Router credential with transport=tcp,
  # host=127.0.0.1, port=$PORT.

  # Or hit it directly over the LAN:
  # host=$(echo $HOST | cut -d@ -f2) port=$PORT in the credential.
EOF
