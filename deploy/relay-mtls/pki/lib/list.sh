# `./pki list` — show all issued certs grouped by type, with human expiry.
#
# Reads the TSV ledger only — doesn't re-parse the PEM files. If the ledger and
# the out/ dirs drift apart (manual deletion), the ledger is the source of truth
# for what has been issued; out/ is the source of truth for what's still on disk.

list_cmd() {
  if [ ! -f "$LEDGER" ]; then
    info "Nothing issued yet. Start with: ./pki setup"
    return
  fi

  # Collect rows into three buckets by awk, then pretty-print from bash.
  local ca_rows devices n8ns
  ca_rows=$(awk -F '\t' 'NR>1 && $2=="ca"     && $5=="active"' "$LEDGER" || true)
  devices=$(awk -F '\t' 'NR>1 && $2=="device" && $5=="active"' "$LEDGER" || true)
  n8ns=$(awk   -F '\t' 'NR>1 && $2=="n8n"    && $5=="active"' "$LEDGER" || true)

  if [ -z "$ca_rows" ] && [ -z "$devices" ] && [ -z "$n8ns" ]; then
    info "No active certs. (If you've removed some, './pki list --all' could show them — not implemented yet.)"
    return
  fi

  if [ -n "$devices" ]; then
    printf "${C_BOLD}Devices (server certs):${C_OFF}\n"
    print_rows "$devices"
    printf "\n"
  fi

  if [ -n "$n8ns" ]; then
    printf "${C_BOLD}n8n instances (client certs):${C_OFF}\n"
    print_rows "$n8ns"
    printf "\n"
  fi

  if [ -n "$ca_rows" ]; then
    printf "${C_BOLD}Home CA:${C_OFF}\n"
    print_rows "$ca_rows"
  fi
}

# Internal: print rows in a (nickname, expires, humanized) 3-column layout.
# Arg is a newline-separated batch of TSV rows from the ledger.
print_rows() {
  local rows="$1"
  local nick expires human
  # Read each TSV row.
  while IFS=$'\t' read -r nick _kind _issued expires _status _path; do
    [ -z "$nick" ] && continue
    human=$(humanize_expiry "$expires")
    printf "  %-20s expires %s  ${C_DIM}(%s)${C_OFF}\n" "$nick" "$expires" "$human"
  done <<< "$rows"
}
