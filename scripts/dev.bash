#!/usr/bin/env bash
set -euo pipefail

# Explicit development tasks run inside the selected base workspace.
# DIM does not execute this file automatically or grant it host authority.
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$repo_root"
task="${1:-shell}"
[[ $# -eq 0 ]] || shift
case "$task" in
  help|--help|-h)
    printf '%s\n' \
      'Repository tasks: setup | check | setup-vm | verify-vm [--preflight-only] | tool-setup | agent | web | shell' \
      'KVM verification: bash scripts/dev.bash verify-vm --preflight-only' \
      'Then: bash scripts/dev.bash verify-vm (separate control-plane and host VMs).' \
      'Workspace setup: node scripts/checks/examples-vm-preflight.ts --help'
    ;;
  verify-vm)
    exec bash scripts/checks/examples-vm-smoke.bash "$@"
    ;;
  setup-vm)
    [[ $# -eq 0 ]] || { echo 'setup-vm does not accept arguments' >&2; exit 2; }
    if command -v apk >/dev/null; then
      sudo apk add --no-cache qemu-system-x86_64 qemu-img cloud-utils-localds python3 openssh-client curl git coreutils just
    elif command -v apt-get >/dev/null; then
      sudo apt-get update
      sudo apt-get install -y qemu-system-x86 qemu-utils cloud-image-utils python3 openssh-client curl git coreutils
    else
      echo 'Install QEMU, cloud-localds, Python 3 and OpenSSH for this distribution; see scripts/development.md' >&2
      exit 2
    fi
    exec node scripts/checks/examples-vm-preflight.ts
    ;;
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
    exec dim-agent "$@"
    ;;
  web)
    exec dim-opencode-server "$@"
    ;;
  shell)
    exec bash "$@"
    ;;
  *) echo 'usage: bash scripts/dev.bash [setup|check|setup-vm|verify-vm [--preflight-only]|tool-setup [opencode|codex]|agent TOOL [ARGS...]|web|shell|help]' >&2; exit 2 ;;
esac
