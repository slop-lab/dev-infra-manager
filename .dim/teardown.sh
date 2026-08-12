#!/usr/bin/env sh
set -eu

agent_image="dim-${DIM_WORKSPACE_NAME}-agent"
docker compose --project-name "dim-${DIM_WORKSPACE_NAME}" \
  --file .dim/docker-compose.yml \
  --file /tmp/dim-project-compose-host-aliases.json \
  down --volumes --remove-orphans

if docker image inspect "$agent_image" >/dev/null 2>&1; then
  docker run --rm --privileged --cgroupns host \
    --mount type=bind,source=/sys/fs/cgroup,target=/sys/fs/cgroup \
    --mount type=bind,source="$PWD/.dim/cgroup-delegation.sh",target=/tmp/cgroup-delegation.sh,readonly \
    "$agent_image" sh /tmp/cgroup-delegation.sh teardown
fi
