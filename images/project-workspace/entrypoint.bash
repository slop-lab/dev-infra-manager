#!/usr/bin/env bash
set -euo pipefail

dim_uid="$(id -u dim)"
dim_gid="$(id -g dim)"

initialize_root() {
  local root="$1"
  local description="$2"
  mkdir -p -- "$root"
  [[ ! -L "$root" && -d "$root" ]] || {
    echo "$description root is not a directory: $root" >&2
    exit 1
  }
  if [[ "$(stat -c '%u:%g' -- "$root")" == "$dim_uid:$dim_gid" ]]; then
    return
  fi
  if [[ -n "$(find "$root" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "$description root is populated with incompatible ownership: $root" >&2
    exit 1
  fi
  chown dim:dim -- "$root"
}

initialize_root /home/dim "DIM home"
initialize_root /var/lib/dim/workspace-data "workspace data"
initialize_root /workspace "workspace"
mkdir -p /var/lib/dim/workspace-data/docker /var/run
# A stopped container keeps its writable /var/run layer. Managed containerd
# state is process-namespace-local, so it must not survive a container restart.
rm -rf -- /var/run/docker/containerd
rm -f -- /var/run/docker.pid /var/run/docker.sock

dockerd_args=(
  --host=unix:///var/run/docker.sock
  --data-root=/var/lib/dim/workspace-data/docker
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
  PATH=/home/dim/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  "$@"
