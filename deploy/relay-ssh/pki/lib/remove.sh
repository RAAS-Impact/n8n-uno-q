# `./pki remove <nickname>` — mark a cert decommissioned and delete its files.
#
# This is bookkeeping: there is no CRL or revocation list channel in v1
# (mirrors deploy/relay-mtls/pki/lib/remove.sh). Removal here means the
# cert bundle is gone from disk and the ledger shows the nickname as
# 'removed'. Anyone who still has the key can keep authenticating until
# the cert expires.
#
# If you need *active* revocation before expiry, the pragmatic small-fleet
# answer is to re-bootstrap the CAs and re-issue every cert — faster than
# wiring a revocation channel for 3 devices.

remove_cmd() {
  local nick="${1:-}"
  if [ -z "$nick" ]; then
    err "Usage: ./pki remove <nickname>"
    exit 1
  fi

  if [ ! -f "$LEDGER" ]; then
    err "No ledger found — nothing to remove."
    exit 1
  fi

  local matched_kind=""
  if ledger_has_active "$nick" "device"; then
    matched_kind="device"
  elif ledger_has_active "$nick" "n8n"; then
    matched_kind="n8n"
  else
    err "No active cert called '$nick' found."
    hint "Run './pki list' to see what's issued."
    exit 1
  fi

  local dir
  if [ "$matched_kind" = "device" ]; then
    dir="$DEVICES_DIR/$nick"
  else
    dir="$N8N_DIR/$nick"
  fi

  rm -rf "$dir"
  ledger_mark_removed "$nick" "$matched_kind"

  ok "Removed '$nick' ($matched_kind)."
  hint "The key holder can still authenticate until the cert expires. For active revocation before expiry, re-bootstrap the CAs and re-issue every cert."
}
