# `./pki setup` — one-time bootstrap of the user CA.
#
# Creates ca/user_ca + ca/user_ca.pub. The user CA signs every device cert
# issued afterwards. The embedded ssh2.Server in n8n trusts it as the
# equivalent of OpenSSH's TrustedUserCAKeys.
#
# There is no host CA: the n8n endpoint presents a bare host key (not a
# host cert), and devices verify it via host-key fingerprint pinning.
# See master-plan §14.2 follow-up for the rationale (ssh2 v1.17 doesn't
# advertise host certs, so a host CA would be dead code).
#
# Idempotent: refuses if the CA already exists. Losing the CA private key
# means re-bootstrapping the whole PKI; see README for backup advice.

setup_cmd() {
  require_ssh_keygen

  if [ -f "$USER_CA_KEY" ]; then
    err "A user CA already exists at $USER_CA_KEY."
    hint "To keep your existing CA: nothing to do, carry on with './pki add device <nick>'."
    hint "To start over from scratch: delete the ca/ directory (you will need to re-issue every cert afterwards)."
    exit 1
  fi

  mkdir -p "$CA_DIR"

  info "Creating your user CA..."

  # ed25519: ssh-keygen's modern default. Fast, small (32-byte private key),
  # no passphrase prompt with -N "". Output: <path> (private), <path>.pub.
  # -C is a free-text comment baked into the .pub line for readability.
  ssh-keygen -q -t ed25519 -N "" -C "uno-q-relay-ssh user CA" -f "$USER_CA_KEY"
  chmod 600 "$USER_CA_KEY"
  chmod 644 "$USER_CA_PUB"

  # Initialize ledger so subsequent `add` invocations don't have to
  # special-case "first cert".
  ledger_init_if_missing

  local issued
  issued="$(today_iso)"
  # The CA itself doesn't expire in OpenSSH (no validity on the CA key
  # itself — only on certs they sign). Record a 10-year horizon for human
  # reference; nothing enforces it.
  local horizon
  horizon="$(days_from_now 3650)"
  ledger_add "user_ca" "user_ca" "$issued" "$horizon" "ca/user_ca"

  ok "User CA ready."
  info ""
  info "  CA:  $USER_CA_KEY (signs device user-certs)"
  info ""
  info "Next steps:"
  hint "./pki add n8n laptop                # generate host keypair for your n8n SSH endpoint"
  hint "./pki add device kitchen            # user cert for your first Q"
  info ""
  warn "Back up the ca/ directory somewhere safe — losing user_ca means re-issuing every device cert."
}
