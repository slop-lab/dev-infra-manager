#!/bin/sh
set -eu

chown root:root /usr/bin/newuidmap /usr/bin/newgidmap
chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap

mkdir -p /home/rootless/.local/share/docker /run/user/1000
chown rootless:rootless \
  /home/rootless \
  /home/rootless/.local \
  /home/rootless/.local/share \
  /home/rootless/.local/share/docker \
  /run/user/1000
chmod 0700 /run/user/1000

exec su-exec rootless env \
  HOME=/home/rootless \
  XDG_RUNTIME_DIR=/run/user/1000 \
  dockerd-entrypoint.sh "$@"
