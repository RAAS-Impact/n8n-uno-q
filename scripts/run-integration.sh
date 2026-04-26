#!/usr/bin/env bash
#
# End-to-end integration runner — drives the integration suites for all four
# transport variants (unix / tcp / mtls / ssh) against a real UNO Q.
#
# Pre-requisites the operator owns:
#   1. The Q is reachable via SSH at $UNOQ_HOST (default arduino@linucs.local).
#   2. No relay container is currently running on the Q (this script will
#      bring up + tear down the relay/relay-mtls containers itself).
#   3. PKI material is populated:
#        deploy/relay-mtls/pki/out/devices/<device>/{ca,server.pem,server.key}
#        deploy/relay-mtls/pki/out/n8n/<n8n>/{ca,client.pem,client.key}
#        deploy/relay-ssh/pki/out/devices/<device>/{id_ed25519,id_ed25519-cert.pub,id_ed25519.pub}
#        deploy/relay-ssh/pki/out/n8n/<n8n>/{ssh_host_ed25519_key,ssh_host_ed25519_key.pub,user_ca.pub}
#      Use `./pki setup` then `./pki add device <nick>` / `./pki add n8n <nick>`
#      under each relay package to generate them.
#   4. integration-test.ino is flashed on the MCU (the MCU-dependent tests
#      will fail otherwise — the router-only tests still pass).
#
# What this script does (in order):
#   1. Opens the unix-socket SSH tunnel (/tmp/arduino-router.sock).
#   2. Runs the bridge integration suite over the unix transport.
#   3. Deploys the plain-TCP relay on the Q, runs the suite over tcp,
#      tears the relay down.
#   4. Deploys the mTLS relay on the Q, runs the suite over mtls, tears
#      the relay down.
#   5. Runs the n8n-nodes integration suite over ssh (uses the unix tunnel
#      as the back-channel for a spawned ssh acting as the Q-side autossh
#      stand-in).
#   6. Runs the arduino-cloud integration suite if ARDUINO_CLOUD_CLIENT_ID
#      and ARDUINO_CLOUD_CLIENT_SECRET are set; skips it otherwise. Cloud
#      tests don't need the Q, but they share the orchestrator so a single
#      command exercises everything the user has credentials for.
#   7. Closes the tunnel.
#
# Variants are serialized rather than parallel because the plain and mTLS
# relays both default to port 5775 on the Q. Running them sequentially also
# matches the "one connection at a time" mental model of the suite.
#
# Usage:
#   ./scripts/run-integration.sh
#
# Env overrides (all optional):
#   UNOQ_HOST              user@host (default arduino@linucs.local)
#   UNOQ_TLS_HOST          host the TLS cert was issued for (default linucs.local)
#   UNOQ_TCP_HOST          host the plain-TCP test connects to (default linucs.local)
#   UNOQ_MTLS_DEVICE       mTLS device cert nick (default linucs)
#   UNOQ_MTLS_N8N          mTLS n8n cert nick (default laptop)
#   UNOQ_SSH_DEVICE        SSH device cert nick (default linucs)
#   UNOQ_SSH_N8N           SSH n8n bundle nick (default laptop)
#   UNOQ_BASE              base dir on the Q (default /home/arduino)
#
# Arduino Cloud env (optional — step 6 skips entirely if either of the first
# two are unset). See packages/n8n-nodes-arduino-cloud/test/integration.test.ts
# for the full list and per-test gating:
#   ARDUINO_CLOUD_CLIENT_ID, ARDUINO_CLOUD_CLIENT_SECRET
#   ARDUINO_CLOUD_ORGANIZATION_ID, ARDUINO_CLOUD_TEST_THING_ID,
#   ARDUINO_CLOUD_TEST_PROPERTY_ID, ARDUINO_CLOUD_WRITE_PROPERTY_ID,
#   ARDUINO_CLOUD_WRITE_VALUE, ARDUINO_CLOUD_TRIGGER_VARIABLE_NAME

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Auto-load .env if present so `npm run test:integration` works without the
# user manually exporting cloud creds. See .env.example for the full list.
# `set -a` exports every assignment until `set +a`; subshells (npm, ssh)
# inherit the values cleanly.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

UNOQ_HOST="${UNOQ_HOST:-arduino@linucs.local}"
UNOQ_TLS_HOST="${UNOQ_TLS_HOST:-linucs.local}"
UNOQ_TCP_HOST="${UNOQ_TCP_HOST:-linucs.local}"
UNOQ_MTLS_DEVICE="${UNOQ_MTLS_DEVICE:-linucs}"
UNOQ_MTLS_N8N="${UNOQ_MTLS_N8N:-laptop}"
UNOQ_SSH_DEVICE="${UNOQ_SSH_DEVICE:-linucs}"
UNOQ_SSH_N8N="${UNOQ_SSH_N8N:-laptop}"
UNOQ_BASE="${UNOQ_BASE:-/home/arduino}"

UNIX_SOCK=/tmp/arduino-router.sock
TUNNEL_PID=

# --- helpers ---------------------------------------------------------------

log()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }

remote_relay_down() {
  # Best-effort tear-down of any relay container deployed by previous steps
  # (this script run, or a prior failed run). Ignores missing dirs.
  ssh -o BatchMode=yes "$UNOQ_HOST" "
    if [ -d $UNOQ_BASE/relay ]; then
      cd $UNOQ_BASE/relay && docker compose down --timeout 5 || true
    fi
    if [ -d $UNOQ_BASE/relay-mtls ]; then
      cd $UNOQ_BASE/relay-mtls && docker compose down --timeout 5 || true
    fi
  " 2>/dev/null || warn "remote teardown had issues"
}

cleanup() {
  local exit_code=$?
  log "tearing down"
  remote_relay_down
  if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi
  rm -f "$UNIX_SOCK"
  exit $exit_code
}
trap cleanup EXIT INT TERM

require_file() {
  if [ ! -f "$1" ]; then
    echo "fatal: missing $1" >&2
    echo "       $2" >&2
    exit 2
  fi
}

# --- pre-flight ------------------------------------------------------------

log "pre-flight checks"

MTLS_DEV_BUNDLE="deploy/relay-mtls/pki/out/devices/$UNOQ_MTLS_DEVICE"
MTLS_N8N_BUNDLE="deploy/relay-mtls/pki/out/n8n/$UNOQ_MTLS_N8N"
require_file "$MTLS_DEV_BUNDLE/server.pem" "run: cd deploy/relay-mtls/pki && ./pki add device $UNOQ_MTLS_DEVICE"
require_file "$MTLS_N8N_BUNDLE/client.pem" "run: cd deploy/relay-mtls/pki && ./pki add n8n $UNOQ_MTLS_N8N"

SSH_DEV_BUNDLE="deploy/relay-ssh/pki/out/devices/$UNOQ_SSH_DEVICE"
SSH_N8N_BUNDLE="deploy/relay-ssh/pki/out/n8n/$UNOQ_SSH_N8N"
require_file "$SSH_DEV_BUNDLE/id_ed25519-cert.pub" "run: cd deploy/relay-ssh/pki && ./pki add device $UNOQ_SSH_DEVICE"
require_file "$SSH_N8N_BUNDLE/ssh_host_ed25519_key" "run: cd deploy/relay-ssh/pki && ./pki add n8n $UNOQ_SSH_N8N"

# --- 1. unix tunnel --------------------------------------------------------

log "opening unix-socket tunnel: $UNIX_SOCK → $UNOQ_HOST:/var/run/arduino-router.sock"
rm -f "$UNIX_SOCK"
ssh -N -L "$UNIX_SOCK:/var/run/arduino-router.sock" "$UNOQ_HOST" &
TUNNEL_PID=$!
for _ in $(seq 1 40); do
  [ -S "$UNIX_SOCK" ] && break
  sleep 0.25
done
if [ ! -S "$UNIX_SOCK" ]; then
  echo "fatal: unix tunnel never came up" >&2
  exit 3
fi

# --- 2. unix variant -------------------------------------------------------

log "running integration suite [unix]"
UNOQ_SOCKET="$UNIX_SOCK" \
  npm run --silent test:integration -w packages/bridge

# --- 3. tcp variant --------------------------------------------------------

log "deploying plain TCP relay to $UNOQ_HOST"
UNOQ_HOST="$UNOQ_HOST" ./deploy/relay/install.sh

log "running integration suite [tcp]"
UNOQ_TCP_HOST="$UNOQ_TCP_HOST" UNOQ_TCP_PORT=5775 \
  npm run --silent test:integration -w packages/bridge

log "stopping plain TCP relay"
ssh -o BatchMode=yes "$UNOQ_HOST" "cd $UNOQ_BASE/relay && docker compose down --timeout 5"

# --- 4. mtls variant -------------------------------------------------------

log "deploying mTLS relay to $UNOQ_HOST (device=$UNOQ_MTLS_DEVICE)"
UNOQ_HOST="$UNOQ_HOST" ./deploy/relay-mtls/install.sh --device "$UNOQ_MTLS_DEVICE"

log "running integration suite [mtls]"
UNOQ_TLS_HOST="$UNOQ_TLS_HOST" UNOQ_TLS_PORT=5775 \
UNOQ_TLS_CA="$MTLS_N8N_BUNDLE/ca.pem" \
UNOQ_TLS_CERT="$MTLS_N8N_BUNDLE/client.pem" \
UNOQ_TLS_KEY="$MTLS_N8N_BUNDLE/client.key" \
  npm run --silent test:integration -w packages/bridge

log "stopping mTLS relay"
ssh -o BatchMode=yes "$UNOQ_HOST" "cd $UNOQ_BASE/relay-mtls && docker compose down --timeout 5"

# --- 5. ssh variant --------------------------------------------------------

log "running integration suite [ssh]"
UNOQ_SOCKET="$UNIX_SOCK" \
UNOQ_SSH_DEVICE="$UNOQ_SSH_DEVICE" \
UNOQ_SSH_N8N="$UNOQ_SSH_N8N" \
  npm run --silent test:integration -w packages/n8n-nodes

# --- 6. arduino-cloud (separate stack, gated on cloud creds) ---------------

if [ -n "${ARDUINO_CLOUD_CLIENT_ID:-}" ] && [ -n "${ARDUINO_CLOUD_CLIENT_SECRET:-}" ]; then
  log "running integration suite [arduino-cloud]"
  npm run --silent test:integration -w packages/n8n-nodes-arduino-cloud
else
  log "skipping arduino-cloud — set ARDUINO_CLOUD_CLIENT_ID and ARDUINO_CLOUD_CLIENT_SECRET to run it"
fi

log "all configured integration suites passed"
