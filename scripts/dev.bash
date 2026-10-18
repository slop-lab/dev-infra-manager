#!/usr/bin/env bash
set -euo pipefail

# Explicit development tasks run inside the selected base workspace.
# DIM does not execute this file automatically or grant it host authority.
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$repo_root"
task="${1:-shell}"
[[ $# -eq 0 ]] || shift
case "$task" in
  setup)
    [[ $# -eq 0 ]] || { echo 'setup does not accept arguments' >&2; exit 2; }
    exec pnpm install --frozen-lockfile
    ;;
  check)
    [[ $# -eq 0 ]] || { echo 'check does not accept arguments' >&2; exit 2; }
    pnpm run workspace:build
    pnpm run workspace:check
    exec pnpm run workspace:test
    ;;
  tool-setup)
    exec bash scripts/workspace-user-setup.bash "$@"
    ;;
  agent)
    tool="${1:-opencode}"
    [[ $# -eq 0 ]] || shift
    case "$tool" in opencode|codex) ;; *) echo 'agent accepts opencode or codex' >&2; exit 2 ;; esac
    exec "$HOME/.local/bin/$tool" "$@"
    ;;
  web)
    exec bash scripts/opencode-web.bash "$@"
    ;;
  shell)
    exec bash "$@"
    ;;
  *) echo 'usage: bash scripts/dev.bash [setup|check|tool-setup [opencode|codex]|agent [opencode|codex] [ARGS...]|web|shell]' >&2; exit 2 ;;
esac
