#!/usr/bin/env bash
# Install the stunnel + mTLS relay on a Q.
#
# Rsyncs the relay files and the cert bundle for a specific device to
# $REMOTE_BASE/relay-mtls/ on the host, then runs `docker compose up -d`.
# Idempotent — safe to re-run (e.g. after re-issuing a cert).
#
# Prerequisites:
#   - Run ./pki/pki setup once (first time only)
#   - Run ./pki/pki add device <nick> for this Q
#
# Usage:
#   ./install.sh --device <nick> [--host <user@host>]
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

DEVICE=""
HOST_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --device)   DEVICE="$2"; shift 2 ;;
    --device=*) DEVICE="${1#*=}"; shift ;;
    --host)     HOST_OVERRIDE="$2"; shift 2 ;;
    --host=*)   HOST_OVERRIDE="${1#*=}"; shift ;;
    -h|--help|help)
      cat <<EOF
Usage: $(basename "$0") --device <nickname> [--host <user@host>]

Deploys the mTLS relay using the cert bundle previously issued
by ./pki/pki add device <nickname>.

Options:
  --device <nickname>  (required) Which cert bundle to push to the Q.
  --host <user@host>   Override the target host for this invocation.
                       Without it, UNOQ_HOST (env) or 'arduino@linucs.local'
                       (default) is used.
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $(basename "$0") --device <nickname> [--host <user@host>]" >&2
      exit 1
      ;;
  esac
done
[ -n "$HOST_OVERRIDE" ] && HOST="$HOST_OVERRIDE"

if [ -z "$DEVICE" ]; then
  echo "error: --device <nickname> is required." >&2
  echo "Run ./pki/pki add device <nickname> first, then: $(basename "$0") --device <nickname>" >&2
  exit 1
fi

CERT_BUNDLE="$SCRIPT_DIR/pki/out/devices/$DEVICE"
if [ ! -d "$CERT_BUNDLE" ]; then
  echo "error: no cert bundle at $CERT_BUNDLE" >&2
  echo "Run: $SCRIPT_DIR/pki/pki add device $DEVICE" >&2
  exit 1
fi

# Sanity-check the bundle has the three files stunnel needs. A partial bundle
# would let the container start and then fail obscurely at handshake time.
for f in ca.pem server.pem server.key; do
  if [ ! -f "$CERT_BUNDLE/$f" ]; then
    echo "error: $CERT_BUNDLE/$f is missing — re-run ./pki add device $DEVICE" >&2
    exit 1
  fi
done

REMOTE_DIR="$REMOTE_BASE/relay-mtls"

echo "Installing mTLS relay for device '$DEVICE' on $HOST..."

ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p $REMOTE_DIR/certs"

# Sync the Q-side container assets under q/. The installer scripts, README
# and PKI tooling live at the package root and aren't shipped — see
# docs/master-plan/14-relay-ssh.md §14.5 for the q/ convention.
# Exclude certs/ — populated separately below with the device-specific bundle.
rsync -av --delete -e "$SSH_CMD" \
  --exclude certs \
  "$SCRIPT_DIR/q/" "$HOST:$REMOTE_DIR/"

# Push the device cert bundle. No --delete: the dir is already fresh from the
# mkdir above, and we want this operation to be additive if the user ever
# manually added anything (they shouldn't, but low-risk).
rsync -av -e "$SSH_CMD" \
  "$CERT_BUNDLE/" "$HOST:$REMOTE_DIR/certs/"

# stunnel reads the cert files at startup only — no hot reload — so `up -d`
# restarts the container if it was already running.
ssh "${SSH_OPTS[@]}" "$HOST" "
  cd $REMOTE_DIR && \
  docker compose up -d && \
  docker compose restart unoq-relay
"

PORT="${UNOQ_RELAY_PORT:-5775}"
cat <<EOF

✓ mTLS relay running on $HOST as device '$DEVICE' (mTLS on port $PORT)

Next steps:
  1. On the PC, find the n8n client bundle at:
     $SCRIPT_DIR/pki/out/n8n/<your-n8n-nick>/
     (Run ./pki add n8n <nick> if you haven't yet.)

  2. In n8n, create an "Arduino UNO Q Router" credential:
     Transport:          TCP
     Host:               <same hostname the cert was issued for>
     Port:               $PORT
     CA Certificate:     paste contents of client bundle's ca.pem
     Client Certificate: paste contents of client.pem
     Client Key:         paste contents of client.key

  3. Click "Test Connection" — the TLS handshake validates the full chain.

Verify manually (optional):
  ssh $HOST 'docker compose -f $REMOTE_DIR/docker-compose.yml ps'
EOF
