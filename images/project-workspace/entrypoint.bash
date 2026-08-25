#!/usr/bin/env bash
set -euo pipefail

mkdir -p /home/dim/.codex /var/lib/docker /var/run /workspace
chown -R dim:dim /home/dim /var/lib/docker /workspace
chmod 0700 /home/dim/.codex
# A stopped container keeps its writable /var/run layer. Managed containerd
# state is process-namespace-local, so it must not survive a container restart.
rm -rf -- /var/run/docker/containerd
rm -f -- /var/run/docker.pid /var/run/docker.sock

if [[ -n "${DOCKER_IPTABLES_LEGACY:-}" ]]; then
  export PATH="/usr/local/sbin/.iptables-legacy:$PATH"
fi

dockerd_args=(
  --host=unix:///var/run/docker.sock
  --data-root=/var/lib/docker
  --group=dim
)
if [[ -n "${DIM_REGISTRY_CACHE_ENDPOINT:-}" ]]; then
  [[ "$DIM_REGISTRY_CACHE_ENDPOINT" =~ ^[A-Za-z0-9.-]+:[1-9][0-9]*$ ]] || {
    echo "invalid DIM_REGISTRY_CACHE_ENDPOINT: $DIM_REGISTRY_CACHE_ENDPOINT" >&2
    exit 2
  }
  dockerd_args+=(
    --registry-mirror="http://$DIM_REGISTRY_CACHE_ENDPOINT"
    --insecure-registry="$DIM_REGISTRY_CACHE_ENDPOINT"
  )
fi

dockerd "${dockerd_args[@]}" ${DIM_DOCKERD_FLAGS:-} >/var/log/dockerd.log 2>&1 &
for _ in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    chgrp dim /var/run/docker.sock
    chmod 0660 /var/run/docker.sock
    break
  fi
  sleep 1
done
docker info >/dev/null 2>&1 || { cat /var/log/dockerd.log >&2; exit 1; }

exec sudo -H -E -u dim env \
  HOME=/home/dim \
  CODEX_HOME=/home/dim/.codex \
  PATH=/home/dim/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  "$@"
