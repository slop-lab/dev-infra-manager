#!/usr/bin/env bash
set -euo pipefail

mkdir -p /workspace /home/dim/.codex /home/dim/.local/share/containers "$XDG_RUNTIME_DIR"
chown -R dim:dim /workspace /home/dim "$XDG_RUNTIME_DIR"
chmod 0700 /home/dim/.codex
chmod 0700 "$XDG_RUNTIME_DIR"

if [[ -n "${DIM_REGISTRY_CACHE_ENDPOINT:-}" ]]; then
  [[ "$DIM_REGISTRY_CACHE_ENDPOINT" =~ ^[A-Za-z0-9.-]+:[1-9][0-9]*$ ]] || {
    echo "invalid DIM_REGISTRY_CACHE_ENDPOINT: $DIM_REGISTRY_CACHE_ENDPOINT" >&2
    exit 2
  }
  mkdir -p /etc/containers/registries.conf.d
  cat >/etc/containers/registries.conf.d/50-dim-cache.conf <<EOF
[[registry]]
prefix = "docker.io"
location = "docker.io"

[[registry.mirror]]
location = "$DIM_REGISTRY_CACHE_ENDPOINT"
insecure = true
EOF
fi

if [[ "$#" -eq 0 ]]; then
  set -- bash
fi

exec sudo -H -E -u dim env \
  HOME=/home/dim \
  CODEX_HOME=/home/dim/.codex \
  PATH=/home/dim/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  "$@"
