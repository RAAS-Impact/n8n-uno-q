#!/usr/bin/env bash
# Uninstall Variant C (mTLS) relay from a Q.
#
# Stops and removes the container, deletes the locally-built image, and
# removes $REMOTE_BASE/relay-mtls/ on the host (including the deployed
# certs/ dir). Leaves arduino-router untouched.
#
# The cert bundle on the PC (deploy/relay-mtls/pki/out/devices/<nick>/) is
# NOT affected — re-install with ./install.sh --device <nick> at any time.
# Use ./pki remove <nick> separately if you want to decommission the cert.
#
# Env overrides:
#   UNOQ_HOST=arduino@kitchen.local
#   UNOQ_BASE=/home/arduino
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=../lib/ssh-multiplex.sh
source "$DEPLOY_DIR/lib/ssh-multiplex.sh"

REMOTE_DIR="$REMOTE_BASE/relay-mtls"

echo "Uninstalling mTLS relay from $HOST..."

ssh "${SSH_OPTS[@]}" "$HOST" "
  if [ -f $REMOTE_DIR/docker-compose.yml ]; then
    cd $REMOTE_DIR && docker compose down --rmi local || true
  fi
  rm -rf $REMOTE_DIR
"

echo "✓ mTLS relay removed from $HOST"
echo ""
echo "(Cert bundle on the PC is untouched. Run ./pki remove <nick> to decommission the cert, or leave it for re-install later.)"
