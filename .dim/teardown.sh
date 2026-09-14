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
if [ -e "$qemu_service_dir/service.pid" ] || [ -L "$qemu_service_dir/service.pid" ]; then
  echo "obsolete QEMU service.pid is not accepted" >&2
  exit 1
fi
node .dim/qemu-service-owner.mjs retire \
  "$qemu_service_dir/service-owner.json" "$qemu_service_dir/service.sock" "$(pwd -P)" 10000

set -- down
test "$keep_volumes" = 1 || set -- "$@" --volumes
set -- "$@" --remove-orphans

docker compose \
  --file .dim/docker-compose.yml \
  --file /tmp/dim-project-compose-host-aliases.json \
  "$@"
