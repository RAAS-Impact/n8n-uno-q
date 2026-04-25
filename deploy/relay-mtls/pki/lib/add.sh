# `./pki add device <nick> [opts]` and `./pki add n8n <nick>` — issue a leaf cert.
#
# Both share the same "generate key → CSR → sign with CA" flow; they differ in
# the Extended Key Usage (serverAuth vs clientAuth) and whether a SAN is needed
# (servers: yes, bound to the hostname/IP clients will connect to; clients: no).

add_cmd() {
  local kind="${1:-}"
  shift || true
  case "$kind" in
    device) add_device "$@" ;;
    n8n)    add_n8n "$@" ;;
    ""|help|--help|-h)
      info "Usage:"
      hint "./pki add device <nickname> [--hostname H] [--ip I]"
      hint "./pki add n8n <nickname>"
      ;;
    *)
      err "Unknown 'add' target: $kind"
      hint "Use 'device' (for a Q) or 'n8n' (for an n8n instance)."
      exit 1
      ;;
  esac
}

# --- add device -------------------------------------------------------------

add_device() {
  require_openssl
  require_ca

  local nick="" hostname="" ip="" days="$SERVER_DAYS"
  while [ $# -gt 0 ]; do
    case "$1" in
      --hostname) hostname="$2"; shift 2 ;;
      --hostname=*) hostname="${1#*=}"; shift ;;
      --ip) ip="$2"; shift 2 ;;
      --ip=*) ip="${1#*=}"; shift ;;
      --days) days="$2"; shift 2 ;;
      --days=*) days="${1#*=}"; shift ;;
      -*)
        err "Unknown option: $1"
        hint "Valid: --hostname <H>, --ip <I>, --days <N>"
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

  # mDNS is the 80% case for home LAN setups — the Q advertises <hostname>.local
  # via avahi, so connections to that name resolve automatically. Operators
  # without mDNS pass --hostname or --ip explicitly.
  [ -z "$hostname" ] && hostname="${nick}.local"

  if ledger_has_active "$nick" "device"; then
    err "A device called '$nick' already exists."
    hint "To re-issue: ./pki remove $nick && ./pki add device $nick [options]"
    exit 1
  fi

  local dir="$DEVICES_DIR/$nick"
  mkdir -p "$dir"

  info "Issuing server cert for device '$nick'..."
  info "  Hostname: $hostname${ip:+  IP: $ip}"

  issue_cert \
    --kind        server \
    --nick        "$nick" \
    --cn          "$nick" \
    --out-dir     "$dir" \
    --out-name    server \
    --days        "$days" \
    --hostname    "$hostname" \
    --ip          "$ip"

  # Include the CA cert in the drop-in bundle so an rsync into the Q's certs/
  # dir is a one-liner for the user.
  cp "$CA_DIR/ca.pem" "$dir/ca.pem"
  chmod 644 "$dir/ca.pem"

  local issued expires
  issued="$(today_iso)"
  expires="$(days_from_now "$days")"
  ledger_add "$nick" "device" "$issued" "$expires" "out/devices/$nick"

  ok "Device '$nick' ready."
  info ""
  info "  Bundle:   $dir/"
  info "            ca.pem, server.pem, server.key"
  info "  Expires:  $expires ($(humanize_expiry "$expires"))"
  info ""
  info "To install on the Q, copy the bundle into the relay's certs/ dir:"
  hint "rsync -av $dir/ arduino@$hostname:~/n8n/relay-mtls/certs/"
  info "Then on the Q:"
  hint "cd ~/n8n/relay-mtls && docker compose restart unoq-relay"
}

# --- add n8n ----------------------------------------------------------------

add_n8n() {
  require_openssl
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

  if ledger_has_active "$nick" "n8n"; then
    err "An n8n identity called '$nick' already exists."
    hint "To re-issue: ./pki remove $nick && ./pki add n8n $nick"
    exit 1
  fi

  local dir="$N8N_DIR/$nick"
  mkdir -p "$dir"

  info "Issuing client cert for n8n instance '$nick'..."

  issue_cert \
    --kind      client \
    --nick      "$nick" \
    --cn        "$nick" \
    --out-dir   "$dir" \
    --out-name  client \
    --days      "$days"

  cp "$CA_DIR/ca.pem" "$dir/ca.pem"
  chmod 644 "$dir/ca.pem"

  local issued expires
  issued="$(today_iso)"
  expires="$(days_from_now "$days")"
  ledger_add "$nick" "n8n" "$issued" "$expires" "out/n8n/$nick"

  ok "n8n identity '$nick' ready."
  info ""
  info "  Bundle:   $dir/"
  info "            ca.pem, client.pem, client.key"
  info "  Expires:  $expires ($(humanize_expiry "$expires"))"
  info ""
  info "In n8n, create an \"Arduino UNO Q Router\" credential with these settings:"
  hint "Transport:          TCP"
  hint "Host:               <your Q hostname, e.g. kitchen.local>"
  hint "Port:               5775"
  hint "CA Certificate:     paste contents of $dir/ca.pem"
  hint "Client Certificate: paste contents of $dir/client.pem"
  hint "Client Key:         paste contents of $dir/client.key"
}

# --- shared cert issuance ---------------------------------------------------
#
# issue_cert --kind server|client --nick N --cn CN --out-dir D --out-name N
#            --days D [--hostname H] [--ip I]
#
# Generates a 2048-bit RSA key and a CA-signed cert with the appropriate EKU
# (serverAuth or clientAuth) and, for servers, a SAN covering the hostname
# (plus optional IP). Cleans up the temp CSR + extension file on success.

issue_cert() {
  local kind="" nick="" cn="" out_dir="" out_name="" days=""
  local hostname="" ip=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --kind) kind="$2"; shift 2 ;;
      --nick) nick="$2"; shift 2 ;;
      --cn) cn="$2"; shift 2 ;;
      --out-dir) out_dir="$2"; shift 2 ;;
      --out-name) out_name="$2"; shift 2 ;;
      --days) days="$2"; shift 2 ;;
      --hostname) hostname="$2"; shift 2 ;;
      --ip) ip="$2"; shift 2 ;;
      *) err "issue_cert: unknown flag $1"; exit 1 ;;
    esac
  done

  local key_path="$out_dir/$out_name.key"
  local pem_path="$out_dir/$out_name.pem"
  local csr_path="$out_dir/$out_name.csr"
  local ext_path="$out_dir/$out_name.ext"

  # Build the extension file. openssl needs this on disk (a heredoc via
  # process substitution works but is brittle across bash/zsh/sh).
  case "$kind" in
    server)
      local san="DNS:$hostname"
      [ -n "$ip" ] && san="$san, IP:$ip"
      cat > "$ext_path" <<EOF
subjectAltName = $san
extendedKeyUsage = serverAuth
basicConstraints = CA:FALSE
EOF
      ;;
    client)
      cat > "$ext_path" <<EOF
extendedKeyUsage = clientAuth
basicConstraints = CA:FALSE
EOF
      ;;
    *) err "issue_cert: unknown --kind '$kind'"; exit 1 ;;
  esac

  # Key
  openssl genrsa -out "$key_path" 2048 2>/dev/null
  chmod 600 "$key_path"

  # CSR
  openssl req -new \
    -key "$key_path" \
    -subj "/CN=$cn" \
    -out "$csr_path" 2>/dev/null

  # Sign with the CA. -CAcreateserial writes/updates ca/ca.srl automatically.
  # Redirecting stderr is deliberate — if sign fails, we re-run under stderr=on
  # so the user sees the openssl error verbatim.
  if ! openssl x509 -req \
        -in "$csr_path" \
        -CA "$CA_DIR/ca.pem" \
        -CAkey "$CA_DIR/ca.key" \
        -CAcreateserial \
        -days "$days" \
        -sha256 \
        -extfile "$ext_path" \
        -out "$pem_path" 2>/tmp/pki-openssl-err.$$; then
    err "openssl failed to sign the cert. Raw error:"
    sed 's/^/  /' /tmp/pki-openssl-err.$$ >&2
    rm -f "/tmp/pki-openssl-err.$$" "$csr_path" "$ext_path"
    exit 1
  fi
  rm -f "/tmp/pki-openssl-err.$$"
  chmod 644 "$pem_path"

  # CSR and ext file were scaffolding — the user only needs key + cert.
  rm -f "$csr_path" "$ext_path"
}
