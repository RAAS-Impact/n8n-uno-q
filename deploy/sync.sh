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
# Wipe first: n8n scans custom/ recursively for *.node.js, so any stale files
# from earlier layouts would be loaded alongside (or instead of) the new ones.
# Pre-create parent dirs via ssh: macOS ships Apple rsync 2.6.9 which lacks --mkpath.
# Each package is synced as { package.json + dist/ } so n8n can discover nodes
# via the "n8n": { "nodes": [...] } entry in package.json.
ssh "$HOST" "rm -rf $REMOTE_DIR/custom/packages && \
  mkdir -p $REMOTE_DIR/custom/packages/bridge/dist $REMOTE_DIR/custom/packages/n8n-nodes/dist"
rsync -av packages/bridge/package.json    "$HOST:$REMOTE_DIR/custom/packages/bridge/"
rsync -av packages/bridge/dist/           "$HOST:$REMOTE_DIR/custom/packages/bridge/dist/"
rsync -av packages/n8n-nodes/package.json "$HOST:$REMOTE_DIR/custom/packages/n8n-nodes/"
rsync -av packages/n8n-nodes/dist/        "$HOST:$REMOTE_DIR/custom/packages/n8n-nodes/dist/"

# Ensure the dev override is applied (adds the ./custom bind-mount) and reload nodes.
# `up -d` reconciles config if changed; `restart` forces n8n to re-scan custom/ after rsync.
ssh "$HOST" "cd $REMOTE_DIR && \
  docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d n8n && \
  docker compose -f docker-compose.yml -f docker-compose.dev.yml restart n8n"

echo "✓ Deployed and restarted n8n on $HOST"
