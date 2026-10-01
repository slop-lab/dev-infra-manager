#!/usr/bin/env sh
set -eu

proxy_dir="/tmp/dim-controller-proxy"
proxy_socket="$proxy_dir/external-url.sock"
export DOCKER_CONFIG="${DOCKER_CONFIG:-/tmp/dim-docker-config}"
mkdir -p "$DOCKER_CONFIG"

if ! curl --fail --silent --unix-socket "$proxy_socket" \
  http://dim-controller/api/urls >/dev/null 2>&1; then
  mkdir -p "$proxy_dir"
  dim-controller-proxy external-url \
    --listen "$proxy_socket" \
    --directory-mode 0755 \
    --socket-mode 0666 \
    --ingress local-http \
    >"$proxy_dir/external-url.log" 2>&1 &
  for attempt in $(seq 1 30); do
    test -S "$proxy_socket" && break
    if [ "$attempt" -eq 30 ]; then
      cat "$proxy_dir/external-url.log" >&2
      exit 1
    fi
    sleep 1
  done
fi

docker compose -f .dim/docker-compose.yml "$@" up --detach --build
