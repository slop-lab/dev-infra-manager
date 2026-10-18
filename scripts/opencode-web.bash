#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$root/plugin-agent-tools/src/assets/opencode-server.bash" "$@"
