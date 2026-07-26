#!/usr/bin/env sh
set -eu

task="${1:?task is required}"
shift

controller() {
  curl --fail --silent --show-error \
    -H "Authorization: Bearer $DIM_CONTROLLER_TOKEN" \
    "$@"
}

case "$task" in
  discover)
    controller "$DIM_CONTROLLER_API/api"
    ;;
  expose-dev)
    ingress="${1:-local-http}"
    controller \
      -H "Content-Type: application/json" \
      --data "$(jq -n --arg ingress "$ingress" '{
        ingress: $ingress,
        service: "dev",
        target: {containers: ["dev"], port: 8080, protocol: "http"}
      }')" \
      "$DIM_CONTROLLER_API/api/urls"
    ;;
  expose-deep)
    ingress="${1:-local-http}"
    controller \
      -H "Content-Type: application/json" \
      --data "$(jq -n --arg ingress "$ingress" '{
        ingress: $ingress,
        service: "deep",
        target: {containers: ["dev", "deep"], port: 5678, protocol: "http"}
      }')" \
      "$DIM_CONTROLLER_API/api/urls"
    ;;
  *)
    echo "unknown task: $task" >&2
    exit 2
    ;;
esac
