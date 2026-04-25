#!/usr/bin/env bash
# Verify a deployed mTLS relay end-to-end.
#
# Three checks, in order — first failure aborts:
#   1. Container is running on the Q (docker compose ps).
#   2. The TCP port is reachable from the PC (nc -z).
#   3. The full chain works: TLS handshake + $/version round-trip via the
#      bridge package, using a local n8n client bundle.
#
# The check is anchored on the *device* you deployed (`--device <nick>`,
# matching install.sh's flag). The n8n client bundle used to perform the
# handshake is auto-discovered: every bundle under pki/out/n8n/ is signed by
# the same CA and is functionally interchangeable. If you have more than one
# n8n bundle issued, pass --n8n <nick> to pick which one.
#
# Usage:
#   ./check.sh --device <nick> [--n8n <nick>] [--host <user@host>] [--port <tcp-port>]
#
# Host resolution (highest to lowest priority):
#   1. --host <user@host>
#   2. UNOQ_HOST env var
#   3. arduino@linucs.local (default)
#
# Other env overrides:
#   UNOQ_BASE=/home/arduino           → base dir on the Q
#   UNOQ_RELAY_PORT=5775              → TCP port to probe
#   UNOQ_TARGET_HOST=<host>           → override the hostname used for the
#                                       PC-side TLS connect. Defaults to the
#                                       host part of $HOST. Must match the SAN
#                                       on the deployed server cert — otherwise
#                                       step 3 fails with "certificate verify
#                                       failed" or a hostname-mismatch error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
# shellcheck source=../lib/ssh-multiplex.sh
source "$DEPLOY_DIR/lib/ssh-multiplex.sh"

DEVICE=""
N8N_NICK=""
HOST_OVERRIDE=""
PORT="${UNOQ_RELAY_PORT:-5775}"
while [ $# -gt 0 ]; do
  case "$1" in
    --device)   DEVICE="$2"; shift 2 ;;
    --device=*) DEVICE="${1#*=}"; shift ;;
    --n8n)      N8N_NICK="$2"; shift 2 ;;
    --n8n=*)    N8N_NICK="${1#*=}"; shift ;;
    --host)     HOST_OVERRIDE="$2"; shift 2 ;;
    --host=*)   HOST_OVERRIDE="${1#*=}"; shift ;;
    --port)     PORT="$2"; shift 2 ;;
    --port=*)   PORT="${1#*=}"; shift ;;
    -h|--help|help)
      cat <<EOF
Usage: $(basename "$0") --device <nickname> [--n8n <nickname>] [--host <user@host>] [--port <tcp-port>]

Verifies the mTLS relay is installed, running, and answering \$/version
end-to-end via the bridge package.

Options:
  --device <nickname>  (required) Which Q to verify. Same nickname you passed
                       to install.sh — picks the device bundle from
                       ./pki/out/devices/<nickname>/ to confirm a deploy was
                       performed locally for this Q.
  --n8n <nickname>     (optional) Which n8n client bundle to use for the
                       TLS handshake. Auto-discovered when only one bundle
                       exists under ./pki/out/n8n/; required to disambiguate
                       when several do.
  --host <user@host>   Override the target host for this invocation.
                       Without it, UNOQ_HOST (env) or 'arduino@linucs.local'
                       (default) is used.
  --port <tcp-port>    TCP port to probe (default 5775, override
                       via UNOQ_RELAY_PORT env).
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $(basename "$0") --device <nickname> [--n8n <nickname>] [--host <user@host>] [--port <tcp-port>]" >&2
      exit 1
      ;;
  esac
done
[ -n "$HOST_OVERRIDE" ] && HOST="$HOST_OVERRIDE"

if [ -z "$DEVICE" ]; then
  echo "error: --device <nickname> is required." >&2
  echo "Pass the same nickname you used with install.sh, e.g.:" >&2
  echo "  $(basename "$0") --device kitchen" >&2
  exit 1
fi

DEVICE_BUNDLE="$SCRIPT_DIR/pki/out/devices/$DEVICE"
if [ ! -d "$DEVICE_BUNDLE" ]; then
  echo "error: no device bundle at $DEVICE_BUNDLE" >&2
  echo "Either you haven't deployed this device yet, or the local PKI was" >&2
  echo "regenerated since. Run:" >&2
  echo "  $SCRIPT_DIR/pki/pki add device $DEVICE" >&2
  echo "  $SCRIPT_DIR/install.sh --device $DEVICE --host \${UNOQ_HOST:-arduino@<q>}" >&2
  exit 1
fi

# Auto-discover an n8n bundle if not explicitly chosen. Every n8n bundle is
# signed by the same CA, so any of them works for the probe — we only need to
# disambiguate when more than one exists.
N8N_OUT="$SCRIPT_DIR/pki/out/n8n"
if [ -z "$N8N_NICK" ]; then
  N8N_DIRS=()
  if [ -d "$N8N_OUT" ]; then
    for d in "$N8N_OUT"/*/; do
      [ -d "$d" ] || continue
      N8N_DIRS+=("$(basename "$d")")
    done
  fi
  case "${#N8N_DIRS[@]}" in
    0)
      echo "error: no n8n client bundles found under $N8N_OUT" >&2
      echo "Run: $SCRIPT_DIR/pki/pki add n8n <nickname>" >&2
      exit 1
      ;;
    1)
      N8N_NICK="${N8N_DIRS[0]}"
      echo "→ Using n8n client bundle '$N8N_NICK' (auto-discovered)"
      ;;
    *)
      echo "error: multiple n8n client bundles available — pick one with --n8n:" >&2
      printf '  %s\n' "${N8N_DIRS[@]}" >&2
      exit 1
      ;;
  esac
fi

N8N_BUNDLE="$N8N_OUT/$N8N_NICK"
if [ ! -d "$N8N_BUNDLE" ]; then
  echo "error: no n8n client bundle at $N8N_BUNDLE" >&2
  echo "Run: $SCRIPT_DIR/pki/pki add n8n $N8N_NICK" >&2
  exit 1
fi
for f in ca.pem client.pem client.key; do
  if [ ! -f "$N8N_BUNDLE/$f" ]; then
    echo "error: $N8N_BUNDLE/$f is missing — re-run ./pki add n8n $N8N_NICK" >&2
    exit 1
  fi
done

REMOTE_DIR="$REMOTE_BASE/relay-mtls"
TARGET_HOST="${UNOQ_TARGET_HOST:-${HOST#*@}}"

# --- 1. Container running? -----------------------------------------------
echo "→ [1/3] Container running on $HOST..."
RUNNING_ID="$(ssh "${SSH_OPTS[@]}" "$HOST" \
  "docker compose -f $REMOTE_DIR/docker-compose.yml ps --status running --quiet" \
  2>/dev/null || true)"
if [ -z "$RUNNING_ID" ]; then
  echo "✗ No running relay container under $REMOTE_DIR." >&2
  echo "  Run ./install.sh --device <nick> --host $HOST to (re)deploy." >&2
  exit 1
fi
echo "  ok ($RUNNING_ID)"

# --- 2. TCP port reachable from PC? --------------------------------------
echo "→ [2/3] TCP $TARGET_HOST:$PORT reachable from PC..."
if ! nc -z -w 5 "$TARGET_HOST" "$PORT" 2>/dev/null; then
  echo "✗ Could not open TCP $TARGET_HOST:$PORT from this host." >&2
  echo "  Possible causes: firewall on the Q, network path blocked," >&2
  echo "  or wrong UNOQ_TARGET_HOST (current: $TARGET_HOST)." >&2
  exit 1
fi
echo "  ok"

# --- 3. mTLS handshake + \$/version round-trip ---------------------------
echo "→ [3/3] mTLS + \$/version round-trip (device='$DEVICE', client='$N8N_NICK')..."
RESULT="$(PROBE_MODE=tls \
  PROBE_HOST="$TARGET_HOST" \
  PROBE_PORT="$PORT" \
  PROBE_CA_FILE="$N8N_BUNDLE/ca.pem" \
  PROBE_CERT_FILE="$N8N_BUNDLE/client.pem" \
  PROBE_KEY_FILE="$N8N_BUNDLE/client.key" \
  node "$DEPLOY_DIR/lib/probe-version.mjs")" || PROBE_RC=$?
PROBE_RC="${PROBE_RC:-0}"
echo "  $RESULT"
if [ "$PROBE_RC" -ne 0 ]; then
  echo "✗ TLS \$/version probe failed (rc=$PROBE_RC)." >&2
  echo "  If the error mentions hostname/SAN, the cert was issued for a name" >&2
  echo "  other than '$TARGET_HOST' — re-issue with ./pki add device <nick>" >&2
  echo "  --hostname '$TARGET_HOST' or override UNOQ_TARGET_HOST to match." >&2
  exit 1
fi

echo
echo "✓ mTLS relay healthy at $TARGET_HOST:$PORT (device='$DEVICE', client='$N8N_NICK')"
