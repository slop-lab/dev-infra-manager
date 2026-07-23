#!/usr/bin/env bash
set -euo pipefail

mkdir -p /workspace /var/lib/docker /var/run /home/agent
chown -R agent:agent /workspace /home/agent /var/lib/docker
rm -f /var/run/docker.pid /var/run/docker.sock

if [[ "${DEV_INFRA_START_DOCKERD:-1}" == "1" ]]; then
  dockerd \
    --host=unix:///var/run/docker.sock \
    --data-root=/var/lib/docker \
    --group=agent \
    ${DEV_INFRA_DOCKERD_FLAGS:-} \
    >/var/log/dockerd.log 2>&1 &

  for _ in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then
      chgrp agent /var/run/docker.sock
      chmod 0660 /var/run/docker.sock
      break
    fi
    sleep 1
  done
fi

if [[ "$#" -eq 0 ]]; then
  set -- bash
fi

exec sudo -H -E -u agent env HOME=/home/agent "$@"
