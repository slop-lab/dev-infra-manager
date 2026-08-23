#!/usr/bin/env sh
set -eu

: "${DIM_CONTROLLER_API:?DIM_CONTROLLER_API is required}"
: "${DIM_CONTROLLER_TOKEN:?DIM_CONTROLLER_TOKEN is required}"

port="${DIM_EXTERNAL_URL_TEST_PORT:-39091}"
subdomain="${DIM_EXTERNAL_URL_TEST_SUBDOMAIN:-${DIM_WORKSPACE_NAME:-workspace}--dim-tail-smoke}"
ingress="${DIM_EXTERNAL_URL_TEST_INGRESS:-tailscale}"
sentinel="dim-tailscale-smoke-${DIM_WORKSPACE_NAME:-workspace}-$$"

node -e '
  const http = require("node:http");
  const [port, body] = process.argv.slice(1);
  http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(body);
  }).listen(Number(port), "0.0.0.0");
' "$port" "$sentinel" &
server_pid=$!

url_id=""
cleanup() {
  if [ -n "$url_id" ]; then
    curl --fail --silent --show-error \
      -X DELETE \
      -H "Authorization: Bearer $DIM_CONTROLLER_TOKEN" \
      "$DIM_CONTROLLER_API/api/urls/$url_id" >/dev/null || true
  fi
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

payload="$(
  jq -n \
    --arg subdomain "$subdomain" \
    --argjson port "$port" \
    --arg ingress "$ingress" \
    '{
      ingress: $ingress,
      subdomain: $subdomain,
      target: {containers: [], port: $port, protocol: "http"}
    }'
)"
created="$(
  curl --fail --silent --show-error \
    -H "Authorization: Bearer $DIM_CONTROLLER_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$payload" \
    "$DIM_CONTROLLER_API/api/urls"
)"
url_id="$(printf '%s' "$created" | jq -er '.urls[0].id')"
external_url="$(printf '%s' "$created" | jq -er '.urls[0].url')"

resolved="$(curl --fail --silent --show-error --retry 10 --retry-all-errors --retry-delay 1 "$external_url")"
test "$resolved" = "$sentinel"
printf 'ok tailscale external URL: %s\n' "$external_url"
