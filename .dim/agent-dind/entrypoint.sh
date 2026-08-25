#!/bin/sh
set -eu

mkdir -p /var/lib/docker /mnt/agent-home /mnt/workspace-shared-dind
chmod 0700 /mnt/agent-home
chmod 1777 /mnt/workspace-shared-dind

exec dockerd-entrypoint.sh "$@"
