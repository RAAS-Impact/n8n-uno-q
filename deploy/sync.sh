#!/usr/bin/env bash
set -euo pipefail
HOST="${UNOQ_HOST:-arduino@linucs.local}"
REMOTE_DIR="${UNOQ_DIR:-/home/arduino/n8n}"

# Build on PC
npm run build

# Sync deploy dir to the Q
ssh "$HOST" "mkdir -p $REMOTE_DIR"
rsync -av --delete \
  --exclude node_modules --exclude .git --exclude custom \
  ./deploy/ "$HOST:$REMOTE_DIR/"

# Sync built packages into custom/ on the Q.
# Pre-create parent dirs via ssh: macOS ships Apple rsync 2.6.9 which lacks --mkpath.
ssh "$HOST" "mkdir -p $REMOTE_DIR/custom/packages/bridge $REMOTE_DIR/custom/packages/n8n-nodes"
rsync -av --delete \
  packages/bridge/dist/    "$HOST:$REMOTE_DIR/custom/packages/bridge/"
rsync -av --delete \
  packages/n8n-nodes/dist/ "$HOST:$REMOTE_DIR/custom/packages/n8n-nodes/"

# Ensure the dev override is applied (adds the ./custom bind-mount) and reload nodes.
# `up -d` reconciles config if changed; `restart` forces n8n to re-scan custom/ after rsync.
ssh "$HOST" "cd $REMOTE_DIR && \
  docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d n8n && \
  docker compose -f docker-compose.yml -f docker-compose.dev.yml restart n8n"

echo "✓ Deployed and restarted n8n on $HOST"
