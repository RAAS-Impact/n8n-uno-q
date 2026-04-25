#!/usr/bin/env bash
set -euo pipefail

# Shared SSH multiplexing: one auth handshake per invocation, all ssh/rsync
# calls below reuse the same connection. For password-auth users that's one
# prompt total instead of ~six.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/ssh-multiplex.sh
source "$SCRIPT_DIR/lib/ssh-multiplex.sh"

# Build on PC
npm run build

# --- Sync deploy units to the Q ------------------------------------------
# One rsync per unit, each `--delete` scoped to its own target dir so nothing
# outside REMOTE_BASE/{n8n,relay,relay-mtls,relay-ssh}/ can ever be touched — a top-
# level rsync with --delete against $REMOTE_BASE would wipe the user's
# entire home of anything not present in ./deploy/. Don't do that.
#
# Each relay package's container assets live under <package>/q/ on the PC and
# rsync to <package>/ on the Q (see docs/master-plan/14-relay-ssh.md §14.5).
# Installer scripts, READMEs and PKI tooling live at the package root and are
# never shipped — they're omitted by sourcing q/ instead of the package root.
#
# User-supplied state is preserved via --exclude:
#   - n8n/custom/         → bind-mounted packages, rewritten below
#   - n8n/local-files/    → user-accessible files inside workflows
#   - relay-mtls/certs/   → operator-supplied CA + cert + key
#   - relay-ssh/certs/    → operator-supplied user cert + key + host_ca.pub
#   - relay-ssh/.env      → install.sh writes N8N_HOST/N8N_SSH_PORT here
# macOS rsync 2.6.9 (Apple default) lacks --mkpath; pre-create dirs via ssh.
ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p $REMOTE_BASE/n8n $REMOTE_BASE/relay $REMOTE_BASE/relay-mtls $REMOTE_BASE/relay-ssh"

rsync -av --delete -e "$SSH_CMD" \
  --exclude custom --exclude local-files \
  ./deploy/n8n/ "$HOST:$REMOTE_BASE/n8n/"

rsync -av --delete -e "$SSH_CMD" \
  ./deploy/relay/q/ "$HOST:$REMOTE_BASE/relay/"

rsync -av --delete -e "$SSH_CMD" \
  --exclude certs \
  ./deploy/relay-mtls/q/ "$HOST:$REMOTE_BASE/relay-mtls/"

rsync -av --delete -e "$SSH_CMD" \
  --exclude certs --exclude .env \
  ./deploy/relay-ssh/q/ "$HOST:$REMOTE_BASE/relay-ssh/"

# --- Sync built packages into n8n's custom/ ------------------------------
# Wipe first: n8n scans custom/ recursively for *.node.js, so any stale files
# from earlier layouts would be loaded alongside (or instead of) the new
# ones. Each package is synced as { package.json + dist/ } so n8n can
# discover nodes via the "n8n": { "nodes": [...] } entry in package.json.
ssh "${SSH_OPTS[@]}" "$HOST" "rm -rf $REMOTE_BASE/n8n/custom/packages && \
  mkdir -p $REMOTE_BASE/n8n/custom/packages/bridge/dist \
           $REMOTE_BASE/n8n/custom/packages/n8n-nodes/dist \
           $REMOTE_BASE/n8n/custom/packages/n8n-nodes-arduino-cloud/dist"
rsync -av -e "$SSH_CMD" packages/bridge/package.json                 "$HOST:$REMOTE_BASE/n8n/custom/packages/bridge/"
rsync -av -e "$SSH_CMD" packages/bridge/dist/                        "$HOST:$REMOTE_BASE/n8n/custom/packages/bridge/dist/"
rsync -av -e "$SSH_CMD" packages/n8n-nodes/package.json              "$HOST:$REMOTE_BASE/n8n/custom/packages/n8n-nodes/"
rsync -av -e "$SSH_CMD" packages/n8n-nodes/dist/                     "$HOST:$REMOTE_BASE/n8n/custom/packages/n8n-nodes/dist/"
rsync -av -e "$SSH_CMD" packages/n8n-nodes-arduino-cloud/package.json "$HOST:$REMOTE_BASE/n8n/custom/packages/n8n-nodes-arduino-cloud/"
rsync -av -e "$SSH_CMD" packages/n8n-nodes-arduino-cloud/dist/        "$HOST:$REMOTE_BASE/n8n/custom/packages/n8n-nodes-arduino-cloud/dist/"

# --- Reload n8n to pick up the new bundle --------------------------------
# `up -d` reconciles config if changed; `restart` forces n8n to re-scan
# custom/ after rsync. The relay containers are deployed manually by the
# user via deploy/relay/install.sh, deploy/relay-mtls/install.sh, or
# deploy/relay-ssh/install.sh — they are NOT started or restarted here
# even though their compose files were synced above.
ssh "${SSH_OPTS[@]}" "$HOST" "cd $REMOTE_BASE/n8n && \
  docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d n8n && \
  docker compose -f docker-compose.yml -f docker-compose.dev.yml restart n8n"

echo "✓ Deployed and restarted n8n on $HOST"
