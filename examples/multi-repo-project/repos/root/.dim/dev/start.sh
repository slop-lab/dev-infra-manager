#!/usr/bin/env sh
set -eu

dockerd-entrypoint.sh dockerd >/var/log/dockerd.log 2>&1 &
dockerd_pid=$!
trap 'kill "$dockerd_pid" 2>/dev/null || true' INT TERM

until docker info >/dev/null 2>&1; do
  kill -0 "$dockerd_pid" 2>/dev/null || {
    cat /var/log/dockerd.log >&2
    exit 1
  }
  sleep 1
done

wait "$dockerd_pid"
