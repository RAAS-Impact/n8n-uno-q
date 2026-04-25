# `./pki add device <nick>` — issue a user cert for a Q.
# `./pki add n8n   <nick>` — generate a host keypair for an n8n endpoint.
#
# Two flavours, asymmetric:
#
#   device → user cert, signed by user_ca, principal=tunnel,
#            KeyID=<nick> (routing key), valid CLIENT_DAYS (default 10y),
#            extension permit-port-forwarding only.
#
#   n8n    → plain host keypair (no cert). The embedded ssh2.Server
#            in n8n cannot present host certs (master-plan §14.2 follow-up
#            — ssh2 v1.17 ignores them); devices verify it via host-key
#            fingerprint pinning in known_hosts. So this command just
#            generates the keypair, and ships a copy of user_ca.pub for
#            the credential's "User CA public key" field.

add_cmd() {
  local kind="${1:-}"
  shift || true
  case "$kind" in
    device) add_device "$@" ;;
    n8n)    add_n8n "$@" ;;
    ""|help|--help|-h)
      info "Usage:"
      hint "./pki add device <nickname> [--days N]"
      hint "./pki add n8n <nickname>"
      ;;
    *)
      err "Unknown 'add' target: $kind"
      hint "Use 'device' (for a Q autossh client) or 'n8n' (for the n8n SSH endpoint)."
      exit 1
      ;;
  esac
}

# --- add device -------------------------------------------------------------

add_device() {
  require_ssh_keygen
  require_ca

  local nick="" days="$CLIENT_DAYS"
  while [ $# -gt 0 ]; do
    case "$1" in
      --days) days="$2"; shift 2 ;;
      --days=*) days="${1#*=}"; shift ;;
      -*)
        err "Unknown option: $1"
        hint "Valid: --days <N>"
        exit 1
        ;;
      *)
        if [ -z "$nick" ]; then nick="$1"; else
          err "Unexpected extra argument: $1"; exit 1
        fi
        shift
        ;;
    esac
  done

  validate_nickname "$nick" || exit 1
  if ! printf '%s' "$days" | grep -Eq '^[1-9][0-9]*$'; then
    err "Invalid --days value: $days (must be a positive integer)"; exit 1
  fi

  if ledger_has_active "$nick" "device"; then
    err "A device called '$nick' already exists."
    hint "To re-issue: ./pki remove $nick && ./pki add device $nick"
    hint "(Issuing a duplicate keyId would make registry routing last-writer-wins. See master-plan §14.9.)"
    exit 1
  fi

  local dir="$DEVICES_DIR/$nick"
  mkdir -p "$dir"

  local key_path="$dir/id_ed25519"
  local cert_path="$dir/id_ed25519-cert.pub"

  info "Issuing user cert for device '$nick'..."
  info "  Principal: $DEFAULT_PRINCIPAL"
  info "  KeyID:     $nick (routing key)"
  info "  Validity:  ${days} days"

  # 1. Generate the device's keypair.
  ssh-keygen -q -t ed25519 -N "" -C "uno-q-relay-ssh device:$nick" -f "$key_path"
  chmod 600 "$key_path"
  chmod 644 "$key_path.pub"

  # 2. Sign the public key as a user cert.
  #
  # -O clear strips the OpenSSH default permissions (permit-X11-forwarding,
  # permit-agent-forwarding, permit-port-forwarding, permit-pty,
  # permit-user-rc). We then re-add only permit-port-forwarding — that's the
  # one we need for `ssh -R`. The cert can do nothing else: no shell, no PTY,
  # no agent, no rc files.
  #
  # No -z <serial>: with no revocation channel in v1 the serial isn't read
  # by anyone. ssh-keygen will pick its own (default 0).
  local issued expires
  if ! ssh-keygen -q -s "$USER_CA_KEY" \
      -I "$nick" \
      -n "$DEFAULT_PRINCIPAL" \
      -V "+${days}d" \
      -O clear \
      -O permit-port-forwarding \
      "$key_path.pub" 2>/tmp/pki-sshkeygen-err.$$; then
    err "ssh-keygen failed to sign the user cert. Raw error:"
    sed 's/^/  /' /tmp/pki-sshkeygen-err.$$ >&2
    rm -f "/tmp/pki-sshkeygen-err.$$"
    rm -rf "$dir"
    exit 1
  fi
  rm -f "/tmp/pki-sshkeygen-err.$$"
  chmod 644 "$cert_path"

  issued="$(today_iso)"
  expires="$(days_from_now "$days")"
  ledger_add "$nick" "device" "$issued" "$expires" "out/devices/$nick"

  ok "Device '$nick' ready."
  info ""
  info "  Bundle:   $dir/"
  info "            id_ed25519 (private), id_ed25519-cert.pub (cert)"
  info "  Expires:  $expires ($(humanize_expiry "$expires"))"
  info ""
  info "To install on the Q (binds the device to a specific n8n endpoint):"
  hint "$(cd "$PKI_DIR/.." && pwd)/install.sh --device $nick --n8n <n8n-nick> --n8n-host <hostname>"
}

# --- add n8n ----------------------------------------------------------------

add_n8n() {
  require_ssh_keygen
  require_ca

  local nick=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -*)
        err "Unknown option: $1"
        hint "Valid: ./pki add n8n <nickname>  (no flags — host keypair, no cert)"
        exit 1
        ;;
      *)
        if [ -z "$nick" ]; then nick="$1"; else
          err "Unexpected extra argument: $1"; exit 1
        fi
        shift
        ;;
    esac
  done

  validate_nickname "$nick" || exit 1

  if ledger_has_active "$nick" "n8n"; then
    err "An n8n endpoint called '$nick' already exists."
    hint "To re-issue: ./pki remove $nick && ./pki add n8n $nick"
    hint "Re-issuing rotates the host key — every device pinning the previous one"
    hint "will reject the new server until you re-run install.sh on it."
    exit 1
  fi

  local dir="$N8N_DIR/$nick"
  mkdir -p "$dir"

  local key_path="$dir/ssh_host_ed25519_key"

  info "Generating host keypair for n8n endpoint '$nick'..."

  # Plain ed25519 keypair. No cert: the n8n side cannot advertise host
  # certs through ssh2 v1.17, so the device-side trust model is host-key
  # fingerprint pinning. The pubkey we just generated is what each device's
  # known_hosts will be pre-populated with at install time.
  ssh-keygen -q -t ed25519 -N "" -C "uno-q-relay-ssh n8n:$nick" -f "$key_path"
  chmod 600 "$key_path"
  chmod 644 "$key_path.pub"

  # Drop the user CA's public key into the bundle so the embedded
  # ssh2.Server can use it as TrustedUserCAKeys.
  cp "$USER_CA_PUB" "$dir/user_ca.pub"
  chmod 644 "$dir/user_ca.pub"

  # Record in ledger. Host keypairs don't have a validity, so the expires
  # column is `-`.
  local issued
  issued="$(today_iso)"
  ledger_add "$nick" "n8n" "$issued" "-" "out/n8n/$nick"

  ok "n8n endpoint '$nick' ready."
  info ""
  info "  Bundle:   $dir/"
  info "            ssh_host_ed25519_key (private), ssh_host_ed25519_key.pub (host pubkey), user_ca.pub"
  info "  Fingerprint:"
  ssh-keygen -l -f "$key_path.pub" | sed 's/^/    /'
  info ""
  info "In n8n, create an \"Arduino UNO Q SSH Relay\" credential with these settings:"
  hint "Listen address:        0.0.0.0           (or 127.0.0.1 if reverse-proxied)"
  hint "Listen port:           2222              (must be reachable from the Q)"
  hint "Host private key:      paste $key_path"
  hint "User CA public key:    paste $dir/user_ca.pub"
  hint "Required principal:    $DEFAULT_PRINCIPAL"
  info ""
  info "When deploying a device, install.sh --n8n $nick will pre-populate the"
  info "Q's known_hosts with this endpoint's host pubkey (fingerprint pinning)."
}
