#!/usr/bin/env bash
set -euo pipefail

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
[[ "$#" -gt 0 ]] || { echo "usage: $0 COMMAND [ARG ...]" >&2; exit 2; }
[[ "$upstream" =~ ^[A-Za-z0-9.-]+:[1-9][0-9]*$ ]] || {
  echo "invalid DIM_CI_REGISTRY_CACHE_UPSTREAM: $upstream" >&2
  exit 2
}
command -v socat >/dev/null || {
  echo "socat is required when DIM_CI_REGISTRY_CACHE_UPSTREAM is set" >&2
  exit 2
}

socat TCP-LISTEN:5000,fork,reuseaddr "TCP:$upstream" &
relay_pid=$!
cleanup() {
  kill "$relay_pid" >/dev/null 2>&1 || true
  wait "$relay_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# QEMU user networking exposes its host at 10.0.2.2. Docker's host-gateway
# gives a test-created DinD container an equivalent route to this relay.
export DIM_KVM_REGISTRY_MIRROR=http://10.0.2.2:5000
export DIM_DOCKER_REGISTRY_MIRROR=http://host.docker.internal:5000
"$@"
