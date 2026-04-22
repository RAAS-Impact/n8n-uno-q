#!/usr/bin/env bash
set -euo pipefail
HOST="${UNOQ_HOST:-arduino@linucs.local}"
# Base dir on the Q. The three deploy units land under $REMOTE_BASE/{n8n,relay,
# relay-mtls}/, mirroring the repo's deploy/ layout. Used to be UNOQ_DIR
# pointing at a specific subdir; rename signals the new meaning.
REMOTE_BASE="${UNOQ_BASE:-/home/arduino}"

# Build on PC
npm run build

# --- Sync deploy units to the Q ------------------------------------------
# One rsync per unit, each `--delete` scoped to its own target dir so nothing
# outside REMOTE_BASE/{n8n,relay,relay-mtls}/ can ever be touched — a top-
# level rsync with --delete against $REMOTE_BASE would wipe the user's
# entire home of anything not present in ./deploy/. Don't do that.
#
# User-supplied state is preserved via --exclude:
#   - n8n/custom/         → bind-mounted packages, rewritten below
#   - n8n/local-files/    → user-accessible files inside workflows
#   - relay-mtls/certs/   → operator-supplied CA + cert + key
# macOS rsync 2.6.9 (Apple default) lacks --mkpath; pre-create dirs via ssh.
ssh "$HOST" "mkdir -p $REMOTE_BASE/n8n $REMOTE_BASE/relay $REMOTE_BASE/relay-mtls"

rsync -av --delete \
  --exclude custom --exclude local-files \
  ./deploy/n8n/ "$HOST:$REMOTE_BASE/n8n/"

rsync -av --delete ./deploy/relay/ "$HOST:$REMOTE_BASE/relay/"

rsync -av --delete \
  --exclude certs \
  ./deploy/relay-mtls/ "$HOST:$REMOTE_BASE/relay-mtls/"

# --- Sync built packages into n8n's custom/ ------------------------------
# Wipe first: n8n scans custom/ recursively for *.node.js, so any stale files
# from earlier layouts would be loaded alongside (or instead of) the new
# ones. Each package is synced as { package.json + dist/ } so n8n can
# discover nodes via the "n8n": { "nodes": [...] } entry in package.json.
ssh "$HOST" "rm -rf $REMOTE_BASE/n8n/custom/packages && \
  mkdir -p $REMOTE_BASE/n8n/custom/packages/bridge/dist \
           $REMOTE_BASE/n8n/custom/packages/n8n-nodes/dist"
rsync -av packages/bridge/package.json    "$HOST:$REMOTE_BASE/n8n/custom/packages/bridge/"
rsync -av packages/bridge/dist/           "$HOST:$REMOTE_BASE/n8n/custom/packages/bridge/dist/"
rsync -av packages/n8n-nodes/package.json "$HOST:$REMOTE_BASE/n8n/custom/packages/n8n-nodes/"
rsync -av packages/n8n-nodes/dist/        "$HOST:$REMOTE_BASE/n8n/custom/packages/n8n-nodes/dist/"

# --- Reload n8n to pick up the new bundle --------------------------------
# `up -d` reconciles config if changed; `restart` forces n8n to re-scan
# custom/ after rsync. The relay containers are deployed manually by the
# user (one-time setup per Q); they are NOT started or restarted here even
# though their compose files were synced above.
ssh "$HOST" "cd $REMOTE_BASE/n8n && \
  docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d n8n && \
  docker compose -f docker-compose.yml -f docker-compose.dev.yml restart n8n"

echo "✓ Deployed and restarted n8n on $HOST"
