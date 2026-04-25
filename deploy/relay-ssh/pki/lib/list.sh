# `./pki list` — show all issued certs grouped by type, with human expiry.
#
# Reads the TSV ledger only — doesn't re-parse the cert files. If the ledger
# and the out/ dirs drift apart (manual deletion), the ledger is the source
# of truth for what has been issued; out/ is what's still on disk.

list_cmd() {
  if [ ! -f "$LEDGER" ]; then
    info "Nothing issued yet. Start with: ./pki setup"
    return
  fi

  local cas devices n8ns
  cas=$(awk     -F '\t' 'NR>1 && $2=="user_ca" && $5=="active"' "$LEDGER" || true)
  devices=$(awk -F '\t' 'NR>1 && $2=="device"  && $5=="active"' "$LEDGER" || true)
  n8ns=$(awk    -F '\t' 'NR>1 && $2=="n8n"     && $5=="active"' "$LEDGER" || true)

  if [ -z "$cas" ] && [ -z "$devices" ] && [ -z "$n8ns" ]; then
    info "No active certs. Run ./pki setup if you haven't yet."
    return
  fi

  if [ -n "$devices" ]; then
    printf "${C_BOLD}Devices (user certs — autossh clients):${C_OFF}\n"
    print_rows "$devices"
    printf "\n"
  fi

  if [ -n "$n8ns" ]; then
    printf "${C_BOLD}n8n endpoints (host keypairs — pinned, no cert):${C_OFF}\n"
    print_rows "$n8ns"
    printf "\n"
  fi

  if [ -n "$cas" ]; then
    printf "${C_BOLD}CA:${C_OFF}\n"
    print_rows "$cas"
  fi
}

# Internal: print rows in a (nickname, expires, humanized) layout.
# CAs are long-lived; n8n endpoints carry no expiry (bare keypair, ledger
# stores `-`); device user-certs have a real expiry.
print_rows() {
  local rows="$1"
  local nick kind expires human
  while IFS=$'\t' read -r nick kind _issued expires _status _path; do
    [ -z "$nick" ] && continue
    case "$kind" in
      user_ca)
        printf "  %-18s ${C_DIM}(long-lived (CA))${C_OFF}\n" "$nick"
        ;;
      n8n)
        printf "  %-18s ${C_DIM}(host keypair, pinned by devices)${C_OFF}\n" "$nick"
        ;;
      device)
        human=$(humanize_expiry "$expires")
        printf "  %-18s expires %s  ${C_DIM}(%s)${C_OFF}\n" "$nick" "$expires" "$human"
        ;;
      *)
        printf "  %-18s\n" "$nick"
        ;;
    esac
  done <<< "$rows"
}
