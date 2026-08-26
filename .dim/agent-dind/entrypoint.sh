#!/bin/sh
set -eu

runtime_dir="/run/user/$(id -u rootless)"
docker_data=/home/rootless/.local/share/docker
mkdir -p "$runtime_dir" "$docker_data" /mnt/agent-home /mnt/workspace-shared-dind
chown rootless:rootless "$runtime_dir" "$docker_data" /mnt/agent-home
chmod 0700 "$runtime_dir" /mnt/agent-home
chmod 1777 /mnt/workspace-shared-dind

exec su-exec rootless env \
  HOME=/home/rootless \
  XDG_RUNTIME_DIR="$runtime_dir" \
  DOCKER_HOST="unix://$runtime_dir/docker.sock" \
  dockerd-entrypoint.sh "$@"
