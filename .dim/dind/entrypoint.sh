#!/bin/sh
set -eu

chown root:root /usr/bin/newuidmap /usr/bin/newgidmap
chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap

exec su-exec rootless dockerd-entrypoint.sh "$@"
