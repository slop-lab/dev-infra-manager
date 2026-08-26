#!/usr/bin/env sh
set -eu

export DOCKER_CONFIG="/tmp/dim-workspace-docker-config-$(id -u)"
mkdir -p "$DOCKER_CONFIG"
chmod 0700 "$DOCKER_CONFIG"

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

docker compose \
  --file .dim/docker-compose.yml \
  --file /tmp/dim-project-compose-host-aliases.json \
  down --volumes --remove-orphans
