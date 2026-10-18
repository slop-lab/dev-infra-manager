#!/usr/bin/env bash
set -euo pipefail

dim_uid="$(id -u dim)"
dim_gid="$(id -g dim)"

initialize_user_root() {
  local root="$1"
  mkdir -p -- "$root"
  [[ ! -L "$root" && -d "$root" ]] || {
    printf 'workspace root is not a directory: %s\n' "$root" >&2
    exit 1
  }
  if [[ "$(stat -c '%u:%g' -- "$root")" == "$dim_uid:$dim_gid" ]]; then
    return
  fi
  [[ -z "$(find "$root" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
    printf 'workspace root has incompatible ownership: %s\n' "$root" >&2
    exit 1
  }
  chown dim:dim -- "$root"
}

initialize_user_root /home/dim
initialize_user_root /workspace
mkdir -p /var/run
rm -rf -- /var/run/docker/containerd
rm -f -- /var/run/docker.pid /var/run/docker.sock

dockerd \
  --host=unix:///var/run/docker.sock \
  --data-root=/var/lib/docker \
  --feature containerd-snapshotter=false \
  --group=dim \
  >/var/log/dockerd.log 2>&1 &
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
