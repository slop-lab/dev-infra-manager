#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
node "$repo_root/scripts/examples/native-dev.ts" "$PWD"
"${DIM_BIN:-dim}" tools setup "${DIM_EXAMPLE_WORKSPACE:-codex-dev}" codex
