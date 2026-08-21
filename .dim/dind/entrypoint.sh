#!/bin/sh
set -eu

chown root:root /usr/bin/newuidmap /usr/bin/newgidmap
chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap

docker_data=/home/rootless/.local/share/docker
ownership_marker="$docker_data/.dim-rootless-owner-v1"
mkdir -p "$docker_data" /run/user/1000
if [ ! -f "$ownership_marker" ]; then
  chown -R rootless:rootless "$docker_data"
  su-exec rootless touch "$ownership_marker"
fi
chown rootless:rootless \
  /home/rootless \
  /home/rootless/.local \
  /home/rootless/.local/share \
  "$docker_data" \
  /run/user/1000
chmod 0700 /run/user/1000

exec su-exec rootless env \
  HOME=/home/rootless \
  XDG_RUNTIME_DIR=/run/user/1000 \
  dockerd-entrypoint.sh "$@"
