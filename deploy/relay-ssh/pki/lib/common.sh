# Shared helpers for the relay-ssh `pki` dispatcher. Sourced from every
# subcommand. No shebang — this file is sourced, never executed directly.
#
# Mirrors deploy/relay-mtls/pki/lib/common.sh in shape; differs in the toolset
# (ssh-keygen instead of openssl) and in the artefact mix — relay-ssh has a
# single user CA that signs device certs, plus per-n8n-endpoint bare host
# keypairs (no host certs — see master-plan §14.2 follow-up).

# Paths. PKI_DIR is set by the dispatcher before sourcing.
: "${PKI_DIR:?PKI_DIR must be set by the dispatcher}"
CA_DIR="$PKI_DIR/ca"
OUT_DIR="$PKI_DIR/out"
DEVICES_DIR="$OUT_DIR/devices"
N8N_DIR="$OUT_DIR/n8n"
LEDGER="$PKI_DIR/certs.tsv"

USER_CA_KEY="$CA_DIR/user_ca"
USER_CA_PUB="$CA_DIR/user_ca.pub"

# Validity period (days) for device user certs. Same naming as
# deploy/relay-mtls/pki/lib/common.sh (CLIENT_DAYS = whoever dials).
#
# Default 10 years. With no revocation channel in v1, leaning on long expiry
# + cheap re-bootstrap is the policy. Override per-cert via `--days N` on the
# CLI, or per-invocation via CLIENT_DAYS env var.
#
# Note: there is no SERVER_DAYS in this package — the n8n endpoint presents
# a bare host key (not a host cert), so there's nothing to bound by validity.
# Host-key compromise is handled by re-issuing the keypair and re-deploying
# the bundle to every device (host-key fingerprint pinning, see master-plan
# §14.2 follow-up).
CLIENT_DAYS="${CLIENT_DAYS:-3650}"

# Default user-cert principal. Devices SSH in as this user; the embedded
# ssh2.Server matches against it as a defense-in-depth check (the keyId is
# the actual routing key — see §14.4).
DEFAULT_PRINCIPAL="tunnel"

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
require_ssh_keygen() {
  if ! command -v ssh-keygen >/dev/null 2>&1; then
    err "ssh-keygen not found on PATH."
    hint "It ships with OpenSSH. macOS has it preinstalled. Debian/Ubuntu: apt install openssh-client."
    exit 1
  fi
}

require_ca() {
  if [ ! -f "$USER_CA_KEY" ] || [ ! -f "$USER_CA_PUB" ]; then
    err "The user CA isn't set up yet."
    hint "Run ./pki setup first — that creates the user CA that signs device certs."
    exit 1
  fi
}

# --- Ledger (simple TSV, one row per cert/keypair) --------------------------
# Columns: nickname<TAB>type<TAB>issued<TAB>expires<TAB>status<TAB>path
# type ∈ {user_ca, device, n8n}. status ∈ {active, removed}.
# Same shape as deploy/relay-mtls/pki/lib/common.sh — no `serial` column,
# since neither package implements active revocation in v1.
#
# n8n rows track a plain host keypair (no cert, no expiry). The expires
# column is filled with `-` for those rows.
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
# Lowercase-alnum + dash, max 63 chars. Same rules as relay-mtls — keeps
# filesystem paths and SSH keyId values safe across shells.
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
pki — issue SSH user certs and n8n host keypairs for the reverse-SSH relay.

Usage:
  ./pki setup                              First time: create the user CA
  ./pki add device <nickname> [--days N]   Issue a user cert for a Q (autossh client)
  ./pki add n8n <nickname>                 Generate a host keypair for the n8n SSH endpoint
  ./pki list                               Show all issued material
  ./pki show <nickname> [-v]               Show one cert / keypair's details
  ./pki remove <nickname>                  Decommission (delete files, mark in ledger)
  ./pki help                               This help

Validity default for device user certs: 10 years (3650 days). Override
per-cert via --days N, or per-invocation via the CLIENT_DAYS env var.
The n8n endpoint presents a bare host key (no cert): devices verify it via
known_hosts fingerprint pinning, so 'add n8n' has no --days / --hostname.

Examples:
  ./pki setup                              Run once.
  ./pki add device kitchen                 Default lifetime 10y, principal=tunnel.
  ./pki add device shortlived --days 90    Override default lifetime.
  ./pki add n8n laptop                     Generate host keypair for an n8n endpoint.
  ./pki list
  ./pki show kitchen                       Curated summary (or `ssh-keygen -L` with -v)

All state lives in this directory:
  ca/                  user_ca + user_ca.pub (back this up!)
  out/devices/<nick>/  Per-device bundle: id_ed25519 (private) + id_ed25519-cert.pub
  out/n8n/<nick>/      Per-n8n bundle: ssh_host_ed25519_key + ssh_host_ed25519_key.pub + user_ca.pub
  certs.tsv            Ledger of what was issued, in plain TSV
EOF
}
