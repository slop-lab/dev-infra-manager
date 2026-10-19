#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == --help ]]; then
  echo "usage: $0 --qemu-relay COMMAND [ARG ...]"
  exit 0
fi
[[ "${1:-}" == --qemu-relay ]] || {
  echo "usage: $0 --qemu-relay COMMAND [ARG ...]" >&2
  exit 2
}
shift
[[ "$#" -gt 0 ]] || { echo "usage: $0 --qemu-relay COMMAND [ARG ...]" >&2; exit 2; }

upstream="${DIM_CI_REGISTRY_CACHE_UPSTREAM:-}"
if [[ -z "$upstream" ]] && command -v docker >/dev/null; then
  mirror="$(docker info --format '{{index .RegistryConfig.Mirrors 0}}' 2>/dev/null || true)"
  mirror="${mirror%/}"
  if [[ "$mirror" == http://* ]]; then
    upstream="${mirror#http://}"
  fi
fi
if [[ -z "$upstream" ]]; then
  exec "$@"
fi
[[ "$upstream" =~ ^[A-Za-z0-9.-]+:[1-9][0-9]*$ ]] || {
  echo "invalid DIM_CI_REGISTRY_CACHE_UPSTREAM: $upstream" >&2
  exit 2
}
command -v socat >/dev/null || {
  echo "socat is required when DIM_CI_REGISTRY_CACHE_UPSTREAM is set" >&2
  exit 2
}
if (exec 3<>/dev/tcp/127.0.0.1/5000) 2>/dev/null; then
  exec 3>&- 3<&-
  echo "port 5000 is already occupied; refusing registry-cache relay" >&2
  exit 2
fi

socat TCP-LISTEN:5000,fork,reuseaddr "TCP:$upstream" &
relay_pid=$!
cleanup() {
  kill "$relay_pid" >/dev/null 2>&1 || true
  wait "$relay_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
relay_ready=0
for _attempt in {1..100}; do
  if (exec 3<>/dev/tcp/127.0.0.1/5000) 2>/dev/null; then
    exec 3>&- 3<&-
    relay_ready=1
    break
  fi
  kill -0 "$relay_pid" >/dev/null 2>&1 || {
    wait "$relay_pid" || true
    echo "registry-cache relay exited before readiness" >&2
    exit 1
  }
  sleep 0.05
done
if [[ "$relay_ready" -ne 1 ]]; then
  echo "registry-cache relay readiness timed out" >&2
  exit 1
fi

# QEMU user networking exposes this launcher namespace at 10.0.2.2.
export DIM_KVM_REGISTRY_MIRROR=http://10.0.2.2:5000
export DIM_CI_REGISTRY_CACHE_RELAY_PID="$relay_pid"
"$@"
