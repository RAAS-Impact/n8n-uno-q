# Shared helpers for the `pki` dispatcher. Sourced from every subcommand.
# No shebang — this file is sourced, never executed directly.

# Paths. PKI_DIR is set by the dispatcher before sourcing.
: "${PKI_DIR:?PKI_DIR must be set by the dispatcher}"
CA_DIR="$PKI_DIR/ca"
OUT_DIR="$PKI_DIR/out"
DEVICES_DIR="$OUT_DIR/devices"
N8N_DIR="$OUT_DIR/n8n"
LEDGER="$PKI_DIR/certs.tsv"

# Validity periods (days). Match CONTEXT.md §12.5.3 defaults.
CA_DAYS=3650       # 10 years
SERVER_DAYS=730    # 2 years
CLIENT_DAYS=730    # 2 years

# --- UI: colors only on a TTY so piped output stays clean -------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_GREEN='\033[0;32m'
  C_YELLOW='\033[0;33m'
  C_RED='\033[0;31m'
  C_DIM='\033[0;90m'
  C_BOLD='\033[1m'
  C_OFF='\033[0m'
else
  C_GREEN= C_YELLOW= C_RED= C_DIM= C_BOLD= C_OFF=
fi

ok()   { printf "${C_GREEN}✓${C_OFF} %s\n" "$*"; }
info() { printf "%s\n" "$*"; }
warn() { printf "${C_YELLOW}!${C_OFF} %s\n" "$*" >&2; }
err()  { printf "${C_RED}✗${C_OFF} %s\n" "$*" >&2; }
hint() { printf "  ${C_DIM}%s${C_OFF}\n" "$*"; }

# --- Preconditions ----------------------------------------------------------
require_openssl() {
  if ! command -v openssl >/dev/null 2>&1; then
    err "openssl not found on PATH."
    hint "Install it with your package manager (brew install openssl on macOS, apt install openssl on Debian/Ubuntu)."
    exit 1
  fi
}

require_ca() {
  if [ ! -f "$CA_DIR/ca.key" ] || [ ! -f "$CA_DIR/ca.pem" ]; then
    err "You haven't set up your home CA yet."
    hint "Run ./pki setup first — that creates the root identity your device and n8n certs will be signed with."
    exit 1
  fi
}

# --- Ledger (simple TSV, one row per cert) ----------------------------------
# Columns: nickname<TAB>type<TAB>issued<TAB>expires<TAB>status<TAB>path
# type ∈ {ca, device, n8n}. status ∈ {active, removed}.
ledger_init_if_missing() {
  if [ ! -f "$LEDGER" ]; then
    printf "nickname\ttype\tissued\texpires\tstatus\tpath\n" > "$LEDGER"
  fi
}

ledger_add() {
  local nick="$1" kind="$2" issued="$3" expires="$4" path="$5"
  ledger_init_if_missing
  printf "%s\t%s\t%s\t%s\tactive\t%s\n" "$nick" "$kind" "$issued" "$expires" "$path" >> "$LEDGER"
}

ledger_mark_removed() {
  local nick="$1" kind="$2"
  ledger_init_if_missing
  local tmp
  tmp="$(mktemp)"
  awk -F '\t' -v OFS='\t' -v n="$nick" -v k="$kind" '
    NR == 1 { print; next }
    $1 == n && $2 == k && $5 == "active" { $5 = "removed"; print; next }
    { print }
  ' "$LEDGER" > "$tmp"
  mv "$tmp" "$LEDGER"
}

# Returns 0 if an active entry exists for (nick, kind); 1 otherwise.
ledger_has_active() {
  local nick="$1" kind="$2"
  [ -f "$LEDGER" ] || return 1
  awk -F '\t' -v n="$nick" -v k="$kind" '
    NR > 1 && $1 == n && $2 == k && $5 == "active" { found = 1 }
    END { exit (found ? 0 : 1) }
  ' "$LEDGER"
}

# --- Dates ------------------------------------------------------------------
today_iso()       { date -u +%Y-%m-%d; }
days_from_now()   { # $1 = days ahead → ISO date
  local days="$1"
  if date -u -v +"${days}d" +%Y-%m-%d >/dev/null 2>&1; then
    # BSD date (macOS)
    date -u -v +"${days}d" +%Y-%m-%d
  else
    # GNU date (Linux)
    date -u -d "+${days} days" +%Y-%m-%d
  fi
}

# Human-readable "in X years/months/days" given an ISO YYYY-MM-DD expiry.
humanize_expiry() {
  local expires="$1"
  local now_s exp_s diff days years months
  now_s=$(date -u +%s)
  if date -u -j -f %Y-%m-%d "$expires" +%s >/dev/null 2>&1; then
    exp_s=$(date -u -j -f %Y-%m-%d "$expires" +%s)   # BSD
  else
    exp_s=$(date -u -d "$expires" +%s)                # GNU
  fi
  diff=$(( exp_s - now_s ))
  if [ "$diff" -le 0 ]; then
    printf "expired"
    return
  fi
  days=$(( diff / 86400 ))
  years=$(( days / 365 ))
  months=$(( (days % 365) / 30 ))
  if [ "$years" -ge 1 ]; then
    printf "in %d year%s" "$years" "$([ "$years" -eq 1 ] && echo '' || echo 's')"
  elif [ "$months" -ge 1 ]; then
    printf "in %d month%s" "$months" "$([ "$months" -eq 1 ] && echo '' || echo 's')"
  else
    printf "in %d day%s" "$days" "$([ "$days" -eq 1 ] && echo '' || echo 's')"
  fi
}

# --- Nickname validation ----------------------------------------------------
# Keep it lowercase-alnum + dash to dodge filesystem / CN-escaping surprises.
validate_nickname() {
  local nick="$1"
  if [ -z "$nick" ]; then
    err "Nickname is required."
    return 1
  fi
  if ! printf "%s" "$nick" | grep -Eq '^[a-z0-9][a-z0-9-]{0,62}$'; then
    err "Nickname '$nick' is invalid."
    hint "Use lowercase letters, digits, and dashes only (e.g., 'kitchen', 'garage-02'). Max 63 chars, must start with a letter or digit."
    return 1
  fi
}

# --- Help -------------------------------------------------------------------
print_help() {
  cat <<'EOF'
pki — issue mTLS certificates for the UNO Q relay (Variant C).

Usage:
  ./pki setup                                        First time: create your home CA
  ./pki add device <nickname> [--hostname H] [--ip I]
                                                     Issue a server cert for a Q
  ./pki add n8n <nickname>                           Issue a client cert for an n8n instance
  ./pki list                                         Show all issued certs
  ./pki remove <nickname>                            Decommission a cert (delete files, mark in ledger)
  ./pki help                                         This help

Examples:
  ./pki setup                                        Run once.
  ./pki add device kitchen                           Defaults: hostname = kitchen.local
  ./pki add device garage --hostname garage.home.lan --ip 192.168.1.42
  ./pki add n8n laptop                               For the n8n credential
  ./pki list

All state lives in this directory:
  ca/         Your home CA (back this up! losing ca.key means re-issuing every cert)
  out/        Issued cert bundles, one subdir per device or n8n instance
  certs.tsv   Ledger of who has what, in plain TSV
EOF
}
