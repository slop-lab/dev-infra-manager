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

for node_major in 24 26; do
  DIM_SOURCE_NODE_MAJOR="$node_major" bash verification/scripts/source-gate-container.bash \
    bash -lc 'just check-source-native && pnpm --dir verification test:qemu-service && just verify package-packs && pnpm audit --prod'
  run_node "$node_major" pnpm install --frozen-lockfile
  run_node "$node_major" bash -lc 'just verify plugin-install'
done
run_node 26 bash -lc 'just verify workspace-runtime && bash verification/scripts/container-cgroup-smoke.bash'

if [[ "$manual" == true ]]; then
  run_node 26 bash -lc 'just verify container && bash verification/scripts/container-sysbox-isolation-smoke.bash'
  run_node 26 bash -lc 'test -r /dev/kvm -a -w /dev/kvm && just verify environments-kvm'
  echo "[local-ci] automatic matrix and manual workflows passed"
else
  echo "[local-ci] Node.js 24/26 automatic matrix passed"
fi
