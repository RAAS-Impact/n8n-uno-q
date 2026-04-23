# `./pki show <nick>` — print a curated summary of one cert.
#
# By default prints a human-friendly summary (Subject, Issuer, validity, SAN,
# EKU, fingerprint). With -v / --verbose, prints the full openssl x509 -text
# dump.
#
# Auto-detects whether the nick is a device or an n8n instance via the ledger.
# "./pki show ca" prints the CA cert. Ambiguous names (same nick used for both
# a device and an n8n client) require an explicit `device` / `n8n` disambiguator.

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
  ./pki show <nick> [-v]          Summary of a cert (device or n8n, auto-detected)
  ./pki show device <nick> [-v]   Force device lookup when a nick is used for both
  ./pki show n8n <nick> [-v]      Force n8n lookup when a nick is used for both
  ./pki show ca [-v]              The home CA cert
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
    err "Usage: ./pki show <nick> [-v]  (or 'ca')"
    exit 1
  fi

  require_openssl

  # Special case: the CA cert itself.
  if [ "$target" = "ca" ]; then
    if [ ! -f "$CA_DIR/ca.pem" ]; then
      err "No home CA found."
      hint "Run ./pki setup to create one."
      exit 1
    fi
    _print_cert "$CA_DIR/ca.pem" "ca" "home CA" "$verbose"
    return 0
  fi

  validate_nickname "$target" || exit 1

  # Resolve which bucket(s) contain this nick.
  local in_device=false in_n8n=false
  if [ -f "$LEDGER" ]; then
    if ledger_has_active "$target" "device" || _ledger_has_removed "$target" "device"; then
      in_device=true
    fi
    if ledger_has_active "$target" "n8n" || _ledger_has_removed "$target" "n8n"; then
      in_n8n=true
    fi
  fi

  # Pick which bucket to look up.
  local kind=""
  if [ -n "$explicit_type" ]; then
    kind="$explicit_type"
    if [ "$kind" = "device" ] && ! $in_device; then
      err "No device called '$target' exists."
      hint "Run './pki list' to see what's issued."
      exit 1
    fi
    if [ "$kind" = "n8n" ] && ! $in_n8n; then
      err "No n8n identity called '$target' exists."
      hint "Run './pki list' to see what's issued."
      exit 1
    fi
  elif $in_device && $in_n8n; then
    err "'$target' is both a device and an n8n identity — specify which one."
    hint "./pki show device $target"
    hint "./pki show n8n $target"
    exit 1
  elif $in_device; then
    kind="device"
  elif $in_n8n; then
    kind="n8n"
  else
    err "No cert called '$target' found."
    hint "Run './pki list' to see what's issued, or './pki show ca' for the home CA."
    exit 1
  fi

  # Resolve file paths. Files only exist when the cert is still active; a
  # removed cert has a ledger row but no bundle on disk.
  local dir cert_file label
  if [ "$kind" = "device" ]; then
    dir="$DEVICES_DIR/$target"
    cert_file="$dir/server.pem"
    label="device"
  else
    dir="$N8N_DIR/$target"
    cert_file="$dir/client.pem"
    label="n8n identity"
  fi

  if [ ! -f "$cert_file" ]; then
    warn "'$target' ($label) is in the ledger but its files are no longer on disk."
    hint "The cert was removed via './pki remove $target', or the out/ dir was deleted manually."
    hint "Re-issue with: ./pki add $kind $target"
    exit 1
  fi

  _print_cert "$cert_file" "$kind" "$target" "$verbose"
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

# _print_cert <path> <kind> <display-name> <verbose>
_print_cert() {
  local path="$1" kind="$2" name="$3" verbose="$4"

  if [ "$verbose" = "true" ]; then
    openssl x509 -in "$path" -noout -text
    return 0
  fi

  # Pull the curated fields via a single openssl invocation for speed.
  # Using -subject/-issuer/-dates/-fingerprint separately is clearer than
  # grepping -text, and the output format is stable across openssl versions.
  local subject issuer start end fingerprint
  subject=$(openssl x509 -in "$path" -noout -subject | sed 's/^subject=//')
  issuer=$(openssl  x509 -in "$path" -noout -issuer  | sed 's/^issuer=//')
  start=$(openssl   x509 -in "$path" -noout -startdate | sed 's/^notBefore=//')
  end=$(openssl     x509 -in "$path" -noout -enddate   | sed 's/^notAfter=//')
  # Strip everything up to and including the first `=` — tolerates both
  # "SHA256 Fingerprint=..." (older openssl) and "sha256 Fingerprint=..."
  # (newer LibreSSL on macOS).
  fingerprint=$(openssl x509 -in "$path" -noout -fingerprint -sha256 \
    | sed 's/^[^=]*=//')

  # Derive an ISO expiry date from the openssl output for humanize_expiry().
  # openssl's -enddate format (e.g. "Apr 22 12:00:00 2028 GMT") converts via
  # `date` on both macOS (BSD) and Linux (GNU).
  local end_iso
  if date -u -j -f '%b %d %T %Y %Z' "$end" +%Y-%m-%d >/dev/null 2>&1; then
    end_iso=$(date -u -j -f '%b %d %T %Y %Z' "$end" +%Y-%m-%d)           # BSD
  else
    end_iso=$(date -u -d "$end" +%Y-%m-%d 2>/dev/null || echo "$end")    # GNU
  fi

  # SAN + EKU live in extensions. -ext is openssl 1.1.1+; the Alpine /
  # macOS baseline has it. Empty output = extension absent.
  local san eku
  san=$(openssl x509 -in "$path" -noout -ext subjectAltName 2>/dev/null \
    | awk '/X509v3 Subject Alternative Name/ { getline; sub(/^[[:space:]]+/, ""); print }')
  eku=$(openssl x509 -in "$path" -noout -ext extendedKeyUsage 2>/dev/null \
    | awk '/X509v3 Extended Key Usage/ { getline; sub(/^[[:space:]]+/, ""); print }')

  printf "${C_BOLD}%s${C_OFF} (%s)\n" "$name" "$kind"
  printf "  ${C_DIM}File:${C_OFF}        %s\n" "$path"
  printf "  ${C_DIM}Subject:${C_OFF}     %s\n" "$subject"
  printf "  ${C_DIM}Issuer:${C_OFF}      %s\n" "$issuer"
  printf "  ${C_DIM}Valid from:${C_OFF}  %s\n" "$start"
  printf "  ${C_DIM}Expires:${C_OFF}     %s ${C_DIM}(%s)${C_OFF}\n" "$end" "$(humanize_expiry "$end_iso")"
  if [ -n "$san" ]; then
    printf "  ${C_DIM}Hostnames:${C_OFF}   %s\n" "$san"
  fi
  if [ -n "$eku" ]; then
    printf "  ${C_DIM}Role:${C_OFF}        %s\n" "$(_humanize_eku "$eku")"
  fi
  printf "  ${C_DIM}SHA-256:${C_OFF}     %s\n" "$fingerprint"
  printf "\n"
  hint "Add -v for the full openssl x509 -text dump."
}

# Translate openssl's role strings into one-word labels the user can scan.
# Unknown EKU combinations pass through unchanged.
_humanize_eku() {
  local eku="$1"
  case "$eku" in
    *TLS\ Web\ Server*Client*|*TLS\ Web\ Client*Server*)
      printf "server + client (both roles)" ;;
    *TLS\ Web\ Server*) printf "server (Q relay)" ;;
    *TLS\ Web\ Client*) printf "client (n8n instance)" ;;
    *) printf "%s" "$eku" ;;
  esac
}
