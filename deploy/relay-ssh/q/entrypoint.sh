#!/bin/sh
# Reverse-SSH client entrypoint — opens an outbound SSH connection to the
# n8n endpoint and forwards a localhost port on the n8n side back to the
# router socket on the Q.
#
# Required env:
#   N8N_HOST           Hostname (or IP) of the n8n SSH endpoint. Must match
#                      the hostname pinned in the operator-supplied n8n_host.pub
#                      via known_hosts.
# Optional env:
#   N8N_SSH_PORT       TCP port on N8N_HOST (default 2222).
#   REMOTE_BIND_PORT   The Q-side port the n8n side opens via -R. Arbitrary;
#                      not used as a routing key (the cert's KeyID is). 7000
#                      by default.
#   AUTOSSH_GATETIME   Seconds the SSH session must stay up before autossh
#                      considers it "established". 0 disables the gate (any
#                      reconnect counts) and is what we want here — n8n may
#                      be down for long stretches and we don't want autossh
#                      to give up. Default 0.
#   AUTOSSH_POLL       Seconds between autossh's own connection checks. Also
#                      effectively the retry interval after a refused dial.
#                      Default 30. Lower = quicker recovery, more log noise.
#
# Required cert/key bundle (mounted read-only at /etc/relay-ssh):
#   id_ed25519             — device private key
#   id_ed25519-cert.pub    — user cert signed by user_ca
#   n8n_host.pub           — pinned host pubkey of the n8n SSH endpoint.
#                            Provided by install.sh, copied from
#                            pki/out/n8n/<nick>/ssh_host_ed25519_key.pub.
#
# Trust model — host side: this script writes a regular known_hosts line
# (NOT @cert-authority): the n8n side can't present a host cert through
# ssh2 v1.17, so we pin the bare host pubkey instead. See master-plan
# §14.2 follow-up.
set -eu

: "${N8N_HOST:?N8N_HOST is required (the public hostname of the n8n SSH endpoint)}"
N8N_SSH_PORT="${N8N_SSH_PORT:-2222}"
REMOTE_BIND_PORT="${REMOTE_BIND_PORT:-7000}"
# autossh tunables — exported so the autossh binary picks them up.
export AUTOSSH_GATETIME="${AUTOSSH_GATETIME:-0}"
export AUTOSSH_POLL="${AUTOSSH_POLL:-30}"

CERT_DIR="/etc/relay-ssh"
for f in id_ed25519 id_ed25519-cert.pub n8n_host.pub; do
  if [ ! -f "$CERT_DIR/$f" ]; then
    echo "fatal: missing $CERT_DIR/$f — bind-mount the device cert bundle" >&2
    exit 1
  fi
done

# autossh runs as root in the container; ~/.ssh is /root/.ssh.
mkdir -p ~/.ssh
chmod 700 ~/.ssh

# Pin the n8n endpoint's host pubkey for this hostname (and listen port —
# OpenSSH treats `[host]:port` as a distinct hostkey scope when the port
# isn't 22). No @cert-authority: ssh2 doesn't advertise host certs, so
# we trust the bare key.
HOST_PUB_LINE="$(cat "$CERT_DIR/n8n_host.pub")"
{
  printf '%s %s\n' "$N8N_HOST" "$HOST_PUB_LINE"
  if [ "$N8N_SSH_PORT" != "22" ]; then
    printf '[%s]:%s %s\n' "$N8N_HOST" "$N8N_SSH_PORT" "$HOST_PUB_LINE"
  fi
} > ~/.ssh/known_hosts
chmod 600 ~/.ssh/known_hosts

# autossh -M 0 disables its own monitoring port — modern OpenSSH's
# ServerAliveInterval/CountMax handles dead-tunnel detection just fine and
# avoids the extra exposed port.
#
# ExitOnForwardFailure=yes makes the SSH dial fail (and autossh retry) if
# the remote -R bind can't be set up — better than connecting and having
# the n8n side silently miss the forward.
#
# CertificateFile is the OpenSSH way to pair a key with a cert: -i picks
# the private key, the cert sits next to it.
exec autossh -M 0 -N \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/root/.ssh/known_hosts \
  -i "$CERT_DIR/id_ed25519" \
  -o "CertificateFile=$CERT_DIR/id_ed25519-cert.pub" \
  -R "127.0.0.1:${REMOTE_BIND_PORT}:/host/var/run/arduino-router.sock" \
  -p "$N8N_SSH_PORT" \
  "tunnel@${N8N_HOST}"
