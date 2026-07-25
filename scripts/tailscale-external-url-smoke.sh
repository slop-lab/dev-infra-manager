#!/usr/bin/env sh
set -eu

: "${DIM_EXTERNAL_URLS_API:?DIM_EXTERNAL_URLS_API is required}"
: "${DIM_EXTERNAL_URLS_TOKEN:?DIM_EXTERNAL_URLS_TOKEN is required}"

port="${DIM_EXTERNAL_URL_TEST_PORT:-39091}"
service="${DIM_EXTERNAL_URL_TEST_SERVICE:-dim-tail-smoke}"
route_provider="${DIM_EXTERNAL_URL_TEST_ROUTE_PROVIDER:-}"
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
      -H "Authorization: Bearer $DIM_EXTERNAL_URLS_TOKEN" \
      "$DIM_EXTERNAL_URLS_API/api/external-urls/$url_id" >/dev/null || true
  fi
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

payload="$(
  jq -n \
    --arg service "$service" \
    --argjson port "$port" \
    --arg routeProvider "$route_provider" \
    '{
      service: $service,
      port: $port,
      urlProviders: ["tailscale"]
    } + (if $routeProvider == "" then {} else {routeProvider: $routeProvider} end)'
)"
created="$(
  curl --fail --silent --show-error \
    -H "Authorization: Bearer $DIM_EXTERNAL_URLS_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$payload" \
    "$DIM_EXTERNAL_URLS_API/api/external-urls/request"
)"
url_id="$(printf '%s' "$created" | jq -er '.urls[0].id')"
external_url="$(printf '%s' "$created" | jq -er '.urls[0].url')"

resolved="$(curl --fail --silent --show-error --retry 10 --retry-all-errors --retry-delay 1 "$external_url")"
test "$resolved" = "$sentinel"
printf 'ok tailscale external URL: %s\n' "$external_url"
