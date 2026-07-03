#!/usr/bin/env bash
set -euo pipefail

mkdir -p /workspace /var/lib/docker /var/run /home/agent
chown -R agent:agent /workspace /home/agent

if [[ "${DEV_INFRA_START_DOCKERD:-1}" == "1" ]]; then
  dockerd \
    --host=unix:///var/run/docker.sock \
    --data-root=/var/lib/docker \
    --iptables=false \
    --ip-masq=false \
    >/var/log/dockerd.log 2>&1 &

  for _ in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

if [[ "$#" -eq 0 ]]; then
  set -- bash
fi

exec sudo -H -E -u agent env HOME=/home/agent "$@"
