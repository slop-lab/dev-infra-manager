#!/usr/bin/env bash
set -euo pipefail

mkdir -p /workspace /home/dim/.codex /home/dim/.local/share/containers "$XDG_RUNTIME_DIR"
chown -R dim:dim /workspace /home/dim "$XDG_RUNTIME_DIR"
chmod 0700 /home/dim/.codex
chmod 0700 "$XDG_RUNTIME_DIR"

if [[ "$#" -eq 0 ]]; then
  set -- bash
fi

exec sudo -H -E -u dim env \
  HOME=/home/dim \
  CODEX_HOME=/home/dim/.codex \
  PATH=/home/dim/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  "$@"
