#!/bin/sh
set -eu

chown root:root /usr/bin/newuidmap /usr/bin/newgidmap
chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap

docker_data=/home/rootless/.local/share/docker
ownership_marker="$docker_data/.dim-rootless-owner-v1"
mkdir -p "$docker_data" /run/user/1000
if [ ! -f "$ownership_marker" ]; then
  chown -R rootless:rootless "$docker_data"
fi
# A marker avoids the normal recursive walk, but validate the exact path that
# managed containerd must create. Repair again if a partial/failed prior start
# left new root-owned descendants after the marker was written.
if ! su-exec rootless sh -eu -c '
  mkdir -p "$1"
  : >"$1/.dim-write-probe"
  rm "$1/.dim-write-probe"
' sh "$docker_data/containerd/daemon" 2>/dev/null; then
  chown -R rootless:rootless "$docker_data"
  su-exec rootless mkdir -p "$docker_data/containerd/daemon"
fi
su-exec rootless touch "$ownership_marker"
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
