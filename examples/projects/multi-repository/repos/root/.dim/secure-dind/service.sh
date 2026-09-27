#!/bin/sh
set -eu

service_name="dim-secret-service"
service_image="dim-example-secret-service"

case "${1:?secure service action is required}" in
  deploy)
    : "${EXAMPLE_SECRET:?EXAMPLE_SECRET is required}"
    docker build --quiet --tag "$service_image" - >/dev/null
    docker rm --force "$service_name" >/dev/null 2>&1 || true
    docker run --detach --name "$service_name" --restart unless-stopped \
      --publish 7099:7099 --env "EXAMPLE_SECRET=$EXAMPLE_SECRET" \
      "$service_image" >/dev/null
    for attempt in $(seq 1 60); do
      docker exec "$service_name" wget -qO- http://127.0.0.1:7099/healthz >/dev/null 2>&1 && exit 0
      test "$attempt" -lt 60 || { docker logs "$service_name" >&2; exit 1; }
      sleep 1
    done
    ;;
  health)
    exec docker exec "$service_name" wget -qO- http://127.0.0.1:7099/healthz
    ;;
  remove)
    docker rm --force "$service_name" >/dev/null
    ;;
  *)
    echo "unknown secure service action: $1" >&2
    exit 2
    ;;
esac
