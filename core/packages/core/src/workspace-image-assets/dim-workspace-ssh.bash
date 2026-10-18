#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'dim-workspace-ssh: %s\n' "$*" >&2; exit 2; }
[[ -n "${HOME:-}" && "$HOME" = /* && "$HOME" != *$'\n'* && "$HOME" != *'"'* ]] || fail 'HOME must be absolute and safe for sshd configuration'
state="$HOME/.local/state/dim/ssh"
configuration="$state/sshd_config"
pidfile="$state/sshd.pid"
command="${1:-start}"
[[ $# -eq 0 ]] || shift

owns_process() {
  [[ -r "$pidfile" ]] || return 1
  local pid
  read -r pid <"$pidfile" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  sudo node - "$pid" "$configuration" <<'NODE'
const fs = require('node:fs');
try {
  const args = fs.readFileSync(`/proc/${process.argv[2]}/cmdline`, 'utf8').split('\0');
  // sshd may rewrite argv into a process title. Require its exact private config path.
  process.exit(args.some(value => value.includes('sshd') && value.includes(process.argv[3])) ||
    (args[0]?.endsWith('/sshd') && args[args.indexOf('-f') + 1] === process.argv[3]) ? 0 : 1);
} catch { process.exit(1); }
NODE
}

case "$command" in
  setup)
    [[ $# -le 1 ]] || fail 'usage: dim-workspace-ssh setup [PUBLIC_KEY_FILE] (otherwise read stdin)'
    command -v ssh-keygen >/dev/null || fail 'OpenSSH tools are unavailable in this workspace image'
    [[ -x /usr/sbin/sshd ]] || fail 'OpenSSH server is unavailable in this workspace image'
    mkdir -p -- "$state"
    [[ ! -L "$state" ]] || fail 'SSH state directory must not be a symlink'
    chmod 0700 "$state"
    temporary="$(mktemp "$state/.authorized_keys.XXXXXX")"
    trap 'rm -f -- "$temporary"' EXIT
    if [[ $# -eq 1 ]]; then cat -- "$1" >"$temporary"; else cat >"$temporary"; fi
    [[ "$(stat -c %s "$temporary")" -le 16384 ]] || fail 'public key is too large'
    [[ "$(wc -l <"$temporary")" -le 1 ]] || fail 'provide one public key'
    grep -Eq '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[^ ]+) [A-Za-z0-9+/]+={0,3}( .*)?$' "$temporary" || fail 'provide an OpenSSH public key without authorized_keys options'
    ssh-keygen -lf "$temporary" >/dev/null || fail 'invalid public key'
    chmod 0600 "$temporary"
    mv -- "$temporary" "$state/authorized_keys"
    if [[ ! -f "$state/ssh_host_ed25519_key" ]]; then
      ssh-keygen -q -t ed25519 -N '' -f "$state/ssh_host_ed25519_key"
    fi
    # useradd's initially locked password rejects public-key login on Alpine.
    # An unrecorded random password unlocks the account; sshd still disables all password authentication.
    user="$(id -un)"
    password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))')"
    printf '%s:%s\n' "$user" "$password" | sudo chpasswd
    unset password
    cat >"$configuration" <<CONFIG
Port 2222
ListenAddress 127.0.0.1
HostKey "$state/ssh_host_ed25519_key"
PidFile "$pidfile"
AuthorizedKeysFile "$state/authorized_keys"
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PubkeyAuthentication yes
PermitRootLogin no
AllowUsers $user
AllowTcpForwarding local
PermitOpen 127.0.0.1:* localhost:*
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
Subsystem sftp internal-sftp
CONFIG
    chmod 0600 "$configuration"
    mkdir -p "$HOME/.config/dim"
    printf enabled >"$HOME/.config/dim/ssh-enabled"
    chmod 0600 "$HOME/.config/dim/ssh-enabled"
    exec "$0" start
    ;;
  start)
    [[ $# -eq 0 ]] || fail 'start accepts no arguments'
    [[ -f "$configuration" ]] || exit 0
    if owns_process; then exit 0; fi
    sudo mkdir -p /run/sshd
    sudo /usr/sbin/sshd -t -f "$configuration"
    sudo /usr/sbin/sshd -f "$configuration" -E "$state/sshd.log"
    ;;
  stop)
    [[ $# -eq 0 ]] || fail 'stop accepts no arguments'
    if owns_process; then read -r pid <"$pidfile"; sudo kill "$pid"; fi
    ;;
  host-key)
    [[ $# -eq 0 && -f "$state/ssh_host_ed25519_key.pub" ]] || fail 'SSH is not configured; run setup with your public key first'
    cat -- "$state/ssh_host_ed25519_key.pub"
    ;;
  *) fail 'usage: dim-workspace-ssh setup [PUBLIC_KEY_FILE] | start | stop | host-key' ;;
esac
