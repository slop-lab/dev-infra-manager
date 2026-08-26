#!/usr/bin/env sh
set -eu

qemu_service_dir=/tmp/dim-qemu-verification
if [ -r "$qemu_service_dir/service.pid" ]; then
  qemu_pid="$(cat "$qemu_service_dir/service.pid")"
  case "$qemu_pid" in
    *[!0-9]*|'') ;;
    *)
      kill "$qemu_pid" 2>/dev/null || true
      for _ in $(seq 1 100); do
        kill -0 "$qemu_pid" 2>/dev/null || break
        sleep 0.1
      done
      ;;
  esac
fi

docker compose --project-name "dim-${DIM_WORKSPACE_NAME}" \
  --file .dim/docker-compose.yml \
  --file /tmp/dim-project-compose-host-aliases.json \
  down --volumes --remove-orphans
