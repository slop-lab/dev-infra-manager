#!/usr/bin/env sh
set -eu

export DOCKER_CONFIG="/tmp/dim-workspace-docker-config-$(id -u)"
mkdir -p "$DOCKER_CONFIG"
chmod 0700 "$DOCKER_CONFIG"

keep_volumes="${DIM_WORKSPACE_DISCARD_KEEP_VOLUME-0}"
case "$keep_volumes" in
  0|1) ;;
  *)
    echo "DIM_WORKSPACE_DISCARD_KEEP_VOLUME must be 0 or 1" >&2
    exit 2
    ;;
esac

qemu_service_dir=/tmp/dim-qemu-verification
qemu_project_root="$(pwd -P)"
qemu_service_cwd="$qemu_service_dir"
qemu_node=/usr/bin/node
if [ -e "$qemu_service_dir/service.pid" ] || [ -L "$qemu_service_dir/service.pid" ]; then
  echo "obsolete QEMU service.pid is not accepted" >&2
  exit 1
fi
sudo -n /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
  "$qemu_node" "$qemu_project_root/.dim/qemu-service-owner.mjs" retire \
  "$qemu_service_dir/service-owner.json" "$qemu_service_dir/service.sock" "$qemu_service_cwd" 10000

set -- down
test "$keep_volumes" = 1 || set -- "$@" --volumes
discard_agent_tmp() {
  agent_dind_id="$(docker compose \
    --file .dim/docker-compose.yml \
    --file /tmp/dim-project-compose-host-aliases.json \
    ps --quiet agent-dind)"
  test -z "$agent_dind_id" || docker compose \
    --file .dim/docker-compose.yml \
    --file /tmp/dim-project-compose-host-aliases.json \
    exec --no-TTY --user root agent-dind dim-agent-dind discard-agent-tmp
}
test "$keep_volumes" = 1 || discard_agent_tmp
set -- "$@" --remove-orphans

docker compose \
  --file .dim/docker-compose.yml \
  --file /tmp/dim-project-compose-host-aliases.json \
  "$@"
