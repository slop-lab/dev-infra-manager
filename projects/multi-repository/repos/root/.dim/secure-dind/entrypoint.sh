#!/bin/sh
set -eu

chown root:root /usr/bin/newuidmap /usr/bin/newgidmap
chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap

runtime_dir=/run/dim-secure-dind
docker_data=/home/rootless/.local/share/docker
mkdir -p "$runtime_dir" "$docker_data"
chown rootless:rootless "$runtime_dir" "$docker_data"
chmod 0700 "$runtime_dir"

exec su-exec rootless env \
  HOME=/home/rootless \
  XDG_RUNTIME_DIR="$runtime_dir" \
  DOCKER_HOST="unix://$runtime_dir/docker.sock" \
  dockerd-entrypoint.sh "$@"
