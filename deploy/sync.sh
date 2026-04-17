#!/usr/bin/env bash
set -euo pipefail
HOST="${UNOQ_HOST:-arduino@linucs}"
REMOTE_DIR="${UNOQ_DIR:-/home/arduino/n8n-uno-q}"

# Build on PC
npm run build

# Sync deploy dir
rsync -av --delete \
  --exclude node_modules --exclude .git \
  ./deploy/ "$HOST:$REMOTE_DIR/deploy/"

# Sync built packages into custom/ on the Q
rsync -av --delete \
  packages/bridge/dist/    "$HOST:$REMOTE_DIR/deploy/custom/packages/bridge/"
rsync -av --delete \
  packages/n8n-nodes/dist/ "$HOST:$REMOTE_DIR/deploy/custom/packages/n8n-nodes/"

# Restart n8n to pick up new nodes
ssh "$HOST" "cd $REMOTE_DIR/deploy && docker compose restart n8n"

echo "✓ Deployed and restarted n8n on $HOST"
