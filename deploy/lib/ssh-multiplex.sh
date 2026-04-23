# deploy/lib/ssh-multiplex.sh — shared SSH multiplexing for deploy scripts.
# Source this from any script that issues more than one ssh/rsync to the Q.
#
# Why: without multiplexing, every ssh and rsync negotiates a fresh TCP +
# auth handshake — which, for password-auth users, means a separate password
# prompt per call. Multiplexing authenticates once, then reuses the same
# authenticated channel for every subsequent call. Key-auth users see no
# prompts either way; this helper just spares password-auth users the noise.
#
# Sets (so the sourcing script can use them):
#   HOST         → target host (from UNOQ_HOST; default arduino@linucs.local)
#   REMOTE_BASE  → base directory on the Q (from UNOQ_BASE; default /home/arduino)
#   SSH_OPTS     → bash array of -o flags for `ssh "${SSH_OPTS[@]}" "$HOST" …`
#   SSH_CMD      → flat string for `rsync -e "$SSH_CMD" …`
#
# No cleanup trap: ControlPersist=60 keeps the master alive for 60s after the
# last command exits. That's deliberate — back-to-back scripts (install, then
# a follow-up sync) reuse the authenticated connection and prompt only once.
# SSH cleans up the socket itself when the master terminates.

HOST="${UNOQ_HOST:-arduino@linucs.local}"
REMOTE_BASE="${UNOQ_BASE:-/home/arduino}"

# %r@%h:%p resolves to <user>@<host>:<port>, giving one socket per destination.
# Parallel scripts against the same Q share one master; parallel scripts
# against different Qs don't collide. OpenSSH chmods the socket to 0600.
SSH_OPTS=(
  -o "ControlMaster=auto"
  -o "ControlPath=/tmp/unoq-%r@%h:%p.sock"
  -o "ControlPersist=60"
)

# Keep this expansion in sync with SSH_OPTS. None of our values contain spaces,
# so the naive "${SSH_OPTS[*]}" join is safe.
SSH_CMD="ssh ${SSH_OPTS[*]}"
