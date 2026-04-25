#!/usr/bin/env bash
# Uninstall the reverse-SSH relay from a Q.
#
# Stops and removes the container, deletes the locally-built image, and
# removes $REMOTE_BASE/relay-ssh/ on the host (including the deployed
# certs/ dir and the .env file). Leaves arduino-router untouched.
#
# The cert bundle on the PC (deploy/relay-ssh/pki/out/devices/<nick>/) is
# NOT affected — re-install with `./install.sh --device <nick> --n8n-host <h>`
# at any time. Use `./pki/pki remove <nick>` separately if you also want to
# decommission the cert (bookkeeping only — there is no revocation channel
# in v1; the cert remains valid until expiry).
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

Removes the reverse-SSH relay from the target Q.

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

REMOTE_DIR="$REMOTE_BASE/relay-ssh"

echo "Uninstalling reverse-SSH relay from $HOST..."

ssh "${SSH_OPTS[@]}" "$HOST" "
  if [ -f $REMOTE_DIR/docker-compose.yml ]; then
    cd $REMOTE_DIR && docker compose down --rmi local || true
  fi
  rm -rf $REMOTE_DIR
"

echo "✓ Reverse-SSH relay removed from $HOST"
echo ""
echo "(Cert bundle on the PC is untouched. Run ./pki/pki remove <nick> to decommission the cert in the ledger — bookkeeping only; v1 has no revocation channel.)"
