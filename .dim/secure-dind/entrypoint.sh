#!/bin/sh
set -eu

chown root:root /usr/bin/newuidmap /usr/bin/newgidmap
chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap

docker_data=/home/rootless/.local/share/docker
runtime_dir=/run/user/1000
mkdir -p "$docker_data" "$runtime_dir" /mnt/workspace-shared-dind
rootless_owner="$(id -u rootless):$(id -g rootless)"
actual_owner="$(stat -c %u:%g "$docker_data")"
if [ "$actual_owner" != "$rootless_owner" ]; then
  if [ -n "$(find "$docker_data" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "secure Docker data has incompatible ownership: expected $rootless_owner, found $actual_owner" >&2
    exit 1
  fi
  chown "$rootless_owner" "$docker_data"
fi
chown rootless:rootless "$runtime_dir" /mnt/workspace-shared-dind
chmod 0700 "$runtime_dir"
chmod 1777 /mnt/workspace-shared-dind

exec su-exec rootless env HOME=/home/rootless XDG_RUNTIME_DIR="$runtime_dir" \
  DOCKER_HOST="unix://$runtime_dir/docker.sock" \
  dockerd-entrypoint.sh dockerd --host="unix://$runtime_dir/docker.sock"
