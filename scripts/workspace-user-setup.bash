#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$root/packages/host/plugins/agent-tools/src/assets/tool-setup.bash" "$@"
