#!/usr/bin/env bash
set -euo pipefail

manual=false
for arg in "$@"; do
  case "$arg" in
    --manual) manual=true ;;
    -h|--help)
      echo "usage: bash verification/scripts/local-ci-matrix.bash [--manual]"
      echo "  --manual  also run the manually dispatched Sysbox and KVM workflows"
      exit 0
      ;;
    *)
      echo "error: unknown local CI option: $arg" >&2
      echo "usage: bash verification/scripts/local-ci-matrix.bash [--manual]" >&2
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
run_node 24 bash -lc 'just check-source && just verify plugin-install && pnpm audit --prod && just verify package-packs'

run_node 26 pnpm install --frozen-lockfile
run_node 26 bash -lc 'just check-source && just verify plugin-install && pnpm audit --prod && just verify package-packs'
run_node 26 bash -lc 'just check-source && just verify workspace-runtime && bash verification/scripts/container-cgroup-smoke.bash'

if [[ "$manual" == true ]]; then
  run_node 26 bash -lc 'just check-source && just verify container && bash verification/scripts/container-sysbox-isolation-smoke.bash'
  run_node 26 bash -lc 'test -r /dev/kvm -a -w /dev/kvm && just verify environments-kvm'
  echo "[local-ci] automatic matrix and manual workflows passed"
else
  echo "[local-ci] Node.js 24/26 automatic matrix passed"
fi
