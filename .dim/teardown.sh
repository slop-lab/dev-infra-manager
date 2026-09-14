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
if [ -r "$qemu_service_dir/service.pid" ]; then
  qemu_pid="$(cat "$qemu_service_dir/service.pid")"
  case "$qemu_pid" in
    *[!0-9]*|'') ;;
    *)
      if [ -r "/proc/$qemu_pid/cmdline" ] &&
        tr '\000' ' ' <"/proc/$qemu_pid/cmdline" | grep -Fq '.dim/qemu-service.mjs'; then
        kill "$qemu_pid" 2>/dev/null || true
        for _ in $(seq 1 100); do
          kill -0 "$qemu_pid" 2>/dev/null || break
          sleep 0.1
        done
      fi
      ;;
  esac
fi

set -- down
test "$keep_volumes" = 1 || set -- "$@" --volumes
set -- "$@" --remove-orphans

docker compose \
  --file .dim/docker-compose.yml \
  --file /tmp/dim-project-compose-host-aliases.json \
  "$@"
