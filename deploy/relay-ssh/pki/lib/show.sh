# `./pki show <nick> [-v]` — print a cert's details.
#
# By default prints `ssh-keygen -L -f <cert>` output (already curated and
# human-readable). With -v / --verbose, also prints the raw ssh-keygen -e
# encoded key for copy-paste into known_hosts or authorized_keys.
#
# Auto-detects whether the nick is a device or an n8n endpoint via the
# ledger. "./pki show user_ca" prints the CA pubkey.

show_cmd() {
  local verbose=false target=""
  local explicit_type=""   # "device" | "n8n" | ""

  while [ $# -gt 0 ]; do
    case "$1" in
      -v|--verbose) verbose=true; shift ;;
      device|n8n)
        if [ -n "$explicit_type" ]; then
          err "Specify only one of 'device' / 'n8n'."; exit 1
        fi
        explicit_type="$1"; shift
        ;;
      -h|--help|help)
        cat <<'EOF'
Usage:
  ./pki show <nick> [-v]          Summary of a cert/keypair (device or n8n, auto-detected)
  ./pki show device <nick> [-v]   Force device lookup when a nick is used for both
  ./pki show n8n <nick> [-v]      Force n8n lookup when a nick is used for both
  ./pki show user_ca              The user CA public key
EOF
        return 0
        ;;
      -*) err "Unknown option: $1"; exit 1 ;;
      *)
        if [ -n "$target" ]; then
          err "Unexpected extra argument: $1"; exit 1
        fi
        target="$1"; shift
        ;;
    esac
  done

  if [ -z "$target" ]; then
    err "Usage: ./pki show <nick> [-v]  (or 'user_ca')"
    exit 1
  fi

  require_ssh_keygen

  # Special case: the user CA's public key.
  if [ "$target" = "user_ca" ]; then
    [ -f "$USER_CA_PUB" ] || { err "No user CA found."; hint "Run ./pki setup."; exit 1; }
    printf "${C_BOLD}user_ca${C_OFF} (CA public key)\n"
    printf "  ${C_DIM}File:${C_OFF}      %s\n" "$USER_CA_PUB"
    printf "  ${C_DIM}Fingerprint:${C_OFF}\n"
    ssh-keygen -l -f "$USER_CA_PUB" | sed 's/^/    /'
    printf "  ${C_DIM}Body:${C_OFF}\n"
    sed 's/^/    /' "$USER_CA_PUB"
    return 0
  fi

  validate_nickname "$target" || exit 1

  local in_device=false in_n8n=false
  if [ -f "$LEDGER" ]; then
    if ledger_has_active "$target" "device" || _ledger_has_removed "$target" "device"; then
      in_device=true
    fi
    if ledger_has_active "$target" "n8n" || _ledger_has_removed "$target" "n8n"; then
      in_n8n=true
    fi
  fi

  local kind=""
  if [ -n "$explicit_type" ]; then
    kind="$explicit_type"
    if [ "$kind" = "device" ] && ! $in_device; then
      err "No device called '$target' exists."; hint "Run './pki list'."; exit 1
    fi
    if [ "$kind" = "n8n" ] && ! $in_n8n; then
      err "No n8n endpoint called '$target' exists."; hint "Run './pki list'."; exit 1
    fi
  elif $in_device && $in_n8n; then
    err "'$target' is both a device and an n8n endpoint — specify which one."
    hint "./pki show device $target"
    hint "./pki show n8n $target"
    exit 1
  elif $in_device; then
    kind="device"
  elif $in_n8n; then
    kind="n8n"
  else
    err "No cert or keypair called '$target' found."
    hint "Run './pki list', or './pki show user_ca' for the CA pubkey."
    exit 1
  fi

  # n8n entries are bare keypairs (no cert) — show fingerprint + pubkey only.
  if [ "$kind" = "n8n" ]; then
    local dir="$N8N_DIR/$target"
    local pub_file="$dir/ssh_host_ed25519_key.pub"
    if [ ! -f "$pub_file" ]; then
      warn "'$target' (n8n endpoint) is in the ledger but its files are no longer on disk."
      hint "Re-issue with: ./pki add n8n $target"
      exit 1
    fi
    printf "${C_BOLD}%s${C_OFF} (n8n endpoint host keypair — no cert, devices pin this pubkey)\n" "$target"
    printf "  ${C_DIM}Files:${C_OFF}\n"
    printf "    %s\n" "$dir/ssh_host_ed25519_key (private)"
    printf "    %s\n" "$pub_file"
    printf "    %s\n" "$dir/user_ca.pub"
    printf "  ${C_DIM}Host pubkey fingerprint:${C_OFF}\n"
    ssh-keygen -l -f "$pub_file" | sed 's/^/    /'
    if [ "$verbose" = "true" ]; then
      printf "  ${C_DIM}Host pubkey body:${C_OFF}\n"
      sed 's/^/    /' "$pub_file"
    else
      printf "\n"
      hint "Add -v to also print the raw host pubkey body."
    fi
    return 0
  fi

  local dir="$DEVICES_DIR/$target"
  local cert_file="$dir/id_ed25519-cert.pub"
  local label="device user cert"

  if [ ! -f "$cert_file" ]; then
    warn "'$target' ($label) is in the ledger but its files are no longer on disk."
    hint "The cert was removed via './pki remove $target', or the out/ dir was deleted manually."
    hint "Re-issue with: ./pki add $kind $target"
    exit 1
  fi

  printf "${C_BOLD}%s${C_OFF} (%s)\n" "$target" "$label"
  printf "  ${C_DIM}File:${C_OFF}    %s\n" "$cert_file"
  printf "\n"
  # ssh-keygen -L output: line 1 is the file path (we already printed it),
  # subsequent lines are 8-space-indented top-level fields with 16-space
  # nested values. Strip exactly one indent level so our 2-space pki frame
  # preserves the field/sub-item hierarchy.
  ssh-keygen -L -f "$cert_file" | tail -n +2 | sed 's/^        /  /'

  if [ "$verbose" = "true" ]; then
    printf "\n  ${C_DIM}Cert body:${C_OFF}\n"
    sed 's/^/    /' "$cert_file"
  else
    printf "\n"
    hint "Add -v to also print the raw cert body."
  fi
}

# --- Internals --------------------------------------------------------------

_ledger_has_removed() {
  local nick="$1" kind="$2"
  [ -f "$LEDGER" ] || return 1
  awk -F '\t' -v n="$nick" -v k="$kind" '
    NR > 1 && $1 == n && $2 == k && $5 == "removed" { found = 1 }
    END { exit (found ? 0 : 1) }
  ' "$LEDGER"
}
