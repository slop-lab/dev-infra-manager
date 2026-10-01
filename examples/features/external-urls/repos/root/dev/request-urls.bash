#!/usr/bin/env bash
set -euo pipefail

: "${DIM_CONTROLLER_SOCKET:?DIM_CONTROLLER_SOCKET is required}"
ingress="${DIM_EXTERNAL_URL_INGRESS:-local-http}"

controller() {
  curl --fail --silent --show-error \
    --unix-socket "$DIM_CONTROLLER_SOCKET" \
    "$@"
}

controller http://dim-controller/api |
  jq '{
    ingresses: [
      .routes[]
      | select(.path == "/api/urls" and (.discovery.ingresses | type == "array"))
      | .discovery.ingresses[]
    ]
  }'

controller \
  --header "Content-Type: application/json" \
  --data "$(jq -cn --arg ingress "$ingress" \
    '{ingress:$ingress,target:{containers:["dev"],port:8080,protocol:"http"}}')" \
  http://dim-controller/api/urls

controller \
  --header "Content-Type: application/json" \
  --data "$(jq -cn --arg ingress "$ingress" \
    '{ingress:$ingress,target:{containers:["dev","deep"],port:5678,protocol:"http"}}')" \
  http://dim-controller/api/urls
