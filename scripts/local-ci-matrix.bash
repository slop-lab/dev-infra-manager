#!/usr/bin/env bash
set -euo pipefail

manual=false
for arg in "$@"; do
  case "$arg" in
    --manual) manual=true ;;
    -h|--help)
      echo "usage: just ci matrix [--manual]"
      echo "  --manual  also run the manually dispatched Sysbox and KVM workflows"
      exit 0
      ;;
    *)
      echo "error: unknown local CI option: $arg" >&2
      echo "usage: just ci matrix [--manual]" >&2
      exit 2
      ;;
  esac
done

if ! command -v mise >/dev/null 2>&1; then
  echo "error: mise is required to run the local CI matrix" >&2
  exit 1
fi

run_node() {
  local version="$1"
  shift
  echo "[local-ci] Node.js ${version}: $*"
  mise exec "node@${version}" -- "$@"
}

run_node 24 pnpm install --frozen-lockfile
run_node 24 just ci source

run_node 26 pnpm install --frozen-lockfile
run_node 26 just ci source
run_node 26 just ci workspace

if [[ "$manual" == true ]]; then
  run_node 26 just ci sysbox
  run_node 26 just ci kvm
  echo "[local-ci] automatic matrix and manual workflows passed"
else
  echo "[local-ci] Node.js 24/26 automatic matrix passed"
fi
