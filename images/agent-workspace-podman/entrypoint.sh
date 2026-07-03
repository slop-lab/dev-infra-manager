#!/usr/bin/env bash
set -euo pipefail

mkdir -p /workspace /home/agent/.local/share/containers "$XDG_RUNTIME_DIR"
chown -R agent:agent /workspace /home/agent "$XDG_RUNTIME_DIR"
chmod 0700 "$XDG_RUNTIME_DIR"

if [[ "$#" -eq 0 ]]; then
  set -- bash
fi

exec sudo -H -E -u agent env HOME=/home/agent "$@"
