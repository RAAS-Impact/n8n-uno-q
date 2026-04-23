# `./pki setup` — one-time bootstrap of the home CA.
#
# Creates ca/ca.key + ca/ca.pem. The CA signs every device and n8n cert issued
# afterwards. Losing ca.key means re-bootstrapping the whole PKI (every cert
# already distributed becomes unverifiable); see README for the backup advice.

setup_cmd() {
  require_openssl

  if [ -f "$CA_DIR/ca.key" ] || [ -f "$CA_DIR/ca.pem" ]; then
    err "A CA already exists at $CA_DIR/."
    hint "To keep your existing CA: nothing to do, carry on with './pki add device <nick>'."
    hint "To start over from scratch: delete the ca/ directory (you will need to re-issue every cert afterwards)."
    exit 1
  fi

  mkdir -p "$CA_DIR"

  info "Creating your home CA..."

  # 4096-bit RSA — a CA lives longer than any leaf cert, so err on the generous side.
  # The CA is self-signed; no external trust chain is involved, only devices
  # and n8n instances you personally issue from it.
  openssl genrsa -out "$CA_DIR/ca.key" 4096 2>/dev/null
  chmod 600 "$CA_DIR/ca.key"

  openssl req -x509 -new -nodes \
    -key "$CA_DIR/ca.key" \
    -sha256 \
    -days "$CA_DAYS" \
    -subj "/CN=UNO Q Home CA" \
    -out "$CA_DIR/ca.pem" 2>/dev/null
  chmod 644 "$CA_DIR/ca.pem"

  local issued expires
  issued="$(today_iso)"
  expires="$(days_from_now "$CA_DAYS")"
  ledger_add "ca" "ca" "$issued" "$expires" "ca"

  ok "Home CA ready."
  info ""
  info "  Location:       $CA_DIR/"
  info "  Expires:        $expires ($(humanize_expiry "$expires"))"
  info ""
  info "Next steps:"
  hint "./pki add device kitchen          # issue a server cert for your first Q"
  hint "./pki add n8n laptop              # issue a client cert for your n8n instance"
  info ""
  warn "Back up the ca/ directory somewhere safe — if you lose ca.key you will have to re-issue every cert."
}
