#!/usr/bin/env bash
set -euo pipefail

mkdir -p /home/agent/.codex /var/lib/docker /var/run /workspace
chown -R agent:agent /home/agent /var/lib/docker /workspace
chmod 0700 /home/agent/.codex
rm -f /var/run/docker.pid /var/run/docker.sock

dockerd --host=unix:///var/run/docker.sock --data-root=/var/lib/docker \
  --group=agent >/var/log/dockerd.log 2>&1 &
for _ in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    chgrp agent /var/run/docker.sock
    chmod 0660 /var/run/docker.sock
    break
  fi
  sleep 1
done
docker info >/dev/null 2>&1 || { cat /var/log/dockerd.log >&2; exit 1; }

exec sudo -H -E -u agent env \
  HOME=/home/agent \
  CODEX_HOME=/home/agent/.codex \
  PATH=/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  "$@"
