#!/usr/bin/env bash
set -euo pipefail

suffix="$PPID-$$"
network="dim-ext-$suffix"
client_network="dim-ext-client-$suffix"
root_container="dim-ext-root-$suffix"
dns_container="dim-ext-dns-$suffix"
coredns_container="dim-ext-coredns-$suffix"
caddy_image="dim-ext-caddy-$suffix"
workspace_name="external-$suffix"
state_root="$(mktemp -d /tmp/dim-external-state.XXXXXX)"
plugin_home="$(mktemp -d /tmp/dim-external-plugins.XXXXXX)"
cli_home="$(mktemp -d /tmp/dim-external-cli.XXXXXX)"
pack_root="$(mktemp -d /tmp/dim-external-packs.XXXXXX)"
controller_pid=""
cloudflare_mock_pid=""

available_port() {
  node -e '
    const server = require("node:net").createServer();
    server.listen(0, "127.0.0.1", () => {
      console.log(server.address().port);
      server.close();
    });
  '
}

proxy_port="$(available_port)"
loopback_port="$(available_port)"
cloudflare_mock_port="$(available_port)"
controller_socket="$state_root/controller/controller.sock"

cleanup() {
  if [[ -n "$controller_pid" ]]; then
    kill "$controller_pid" >/dev/null 2>&1 || true
    wait "$controller_pid" 2>/dev/null || true
  fi
  if [[ -n "$cloudflare_mock_pid" ]]; then
    kill "$cloudflare_mock_pid" >/dev/null 2>&1 || true
    wait "$cloudflare_mock_pid" 2>/dev/null || true
  fi
  docker container rm --force "$dns_container" >/dev/null 2>&1 || true
  docker container rm --force "$coredns_container" >/dev/null 2>&1 || true
  docker container rm --force "$root_container" >/dev/null 2>&1 || true
  docker image rm "$caddy_image" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker network rm "$client_network" >/dev/null 2>&1 || true
  find "$state_root" "$plugin_home" "$cli_home" "$pack_root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

echo "[external-url-example] build local packages and workspace image"
pnpm run workspace:build >/dev/null
docker build \
  --quiet \
  --build-arg "DIM_UID=$(id -u)" \
  --build-arg "DIM_GID=$(id -g)" \
  --tag dev-infra-project-workspace:latest \
  images/project-workspace >/dev/null

npm pack ./packages/core/dist --pack-destination "$pack_root" --silent >/dev/null
npm pack ./packages/cli/dist --pack-destination "$pack_root" --silent >/dev/null
npm pack ./packages/contracts/external-url/dist --pack-destination "$pack_root" --silent >/dev/null
npm pack ./packages/ingress/caddy/dist --pack-destination "$pack_root" --silent >/dev/null
npm pack ./packages/provider/dns-cloudflare/dist --pack-destination "$pack_root" --silent >/dev/null
npm pack ./packages/plugin/external-urls/dist --pack-destination "$pack_root" --silent >/dev/null
npm install --prefix "$cli_home" --silent \
  "$pack_root/slop-lab-dim-core-0.2.0.tgz" \
  "$pack_root/slop-lab-dim-contracts-external-url-0.2.0.tgz" \
  "$pack_root/slop-lab-dim-ingress-caddy-0.2.0.tgz" \
  "$pack_root/slop-lab-dim-provider-dns-cloudflare-0.2.0.tgz" \
  "$pack_root/slop-lab-dim-cli-0.2.0.tgz"
npm install --prefix "$plugin_home" --silent \
  "$pack_root/slop-lab-dim-core-0.2.0.tgz" \
  "$pack_root/slop-lab-dim-contracts-external-url-0.2.0.tgz" \
  "$pack_root/slop-lab-dim-ingress-caddy-0.2.0.tgz" \
  "$pack_root/slop-lab-dim-plugin-external-urls-0.2.0.tgz"
jq -n '{schemaVersion:1,plugins:["@slop-lab/dim-plugin-external-urls"]}' \
  > "$plugin_home/plugins.json"
dim_bin="$cli_home/node_modules/.bin/dim"

echo "[external-url-example] load the freshly installed plugin before any ingress exists"
plugin_warning="$state_root/plugin-warning.log"
DIM_PLUGIN_HOME="$plugin_home" \
DIM_CONFIG_PATH="$state_root/dim.json" \
DIM_EXTERNAL_URL_CONFIG="$state_root/external-urls.json" \
  "$dim_bin" plugin list --json \
  >"$state_root/plugin-list.json" 2>"$plugin_warning" \
  || { cat "$plugin_warning" >&2; exit 1; }
jq -e '.plugins == ["@slop-lab/dim-plugin-external-urls"]' "$state_root/plugin-list.json" >/dev/null
grep -Fq "dim external-url ingress add --help" "$plugin_warning"
test ! -e "$state_root/external-urls.json"

echo "[external-url-example] start project-root, dev, and deep containers"
docker network create "$network" >/dev/null
docker network create "$client_network" >/dev/null
mkdir -p "$state_root/cloudflare-zones"
CF_MOCK_PORT="$cloudflare_mock_port" \
CF_MOCK_ZONE="smoke.test" \
CF_MOCK_ZONE_FILE="$state_root/cloudflare-zones/smoke.test.zone" \
  node scripts/cloudflare-dns-mock.mjs >"$state_root/cloudflare-mock.log" 2>&1 &
cloudflare_mock_pid=$!
for attempt in $(seq 1 30); do
  if curl --fail --silent \
    -H "Authorization: Bearer smoke-token" \
    "http://127.0.0.1:$cloudflare_mock_port/client/v4/zones?name=smoke.test" \
    >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    cat "$state_root/cloudflare-mock.log" >&2
    exit 1
  fi
  sleep 1
done
docker run --detach \
  --name "$coredns_container" \
  --network "$network" \
  --volume "$PWD/examples/external-urls/host/cloudflare-local/Corefile:/Corefile:ro" \
  --volume "$state_root/cloudflare-zones:/zones:ro" \
  coredns/coredns@sha256:900f9c109f7a33545d3c811516e8376df9019147b750f5ce3e254468769176ea \
  -conf /Corefile >/dev/null
docker run --detach --privileged \
  --name "$root_container" \
  --network "$network" \
  dev-infra-project-workspace:latest sleep infinity >/dev/null

for attempt in $(seq 1 60); do
  docker exec "$root_container" docker info >/dev/null 2>&1 && break
  if [[ "$attempt" -eq 60 ]]; then
    docker logs "$root_container" >&2
    exit 1
  fi
  sleep 1
done
docker exec "$root_container" mkdir -p /workspace/project
docker cp examples/external-urls/repo/. "$root_container:/workspace/project/"
docker exec "$root_container" docker compose \
  --project-name dim-external-example \
  --file /workspace/project/.dim/docker-compose.yml \
  --profile development \
  up --detach --build >/dev/null

for attempt in $(seq 1 60); do
  if docker exec "$root_container" docker exec dim-external-example-dev-1 \
    wget -qO- http://127.0.0.1:8080 2>/dev/null | grep -qx hello-from-dev; then
    break
  fi
  if [[ "$attempt" -eq 60 ]]; then
    docker exec "$root_container" docker logs dim-external-example-dev-1 >&2
    exit 1
  fi
  sleep 1
done
docker exec "$root_container" docker exec dim-external-example-dev-1 \
  docker container inspect deep >/dev/null

echo "[external-url-example] create controller state and host ingress"
mkdir -p "$state_root/workspaces" "$state_root/workspace-grants"
now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
jq -n \
  --arg name "$workspace_name" \
  --arg container "$root_container" \
  --arg network "$network" \
  --arg now "$now" \
  '{
    schemaVersion: 2,
    name: $name,
    projectId: "external-example-project-id",
    projectName: "external-example",
    rootRepositoryAlias: "root",
    rootRef: "refs/heads/main",
    projectPath: "/workspace/project",
    phase: "ready",
    profiles: ["development"],
    composeProjectName: "dim-external-example",
    containerName: $container,
    networkName: $network,
    dockerVolumeName: "unused-in-smoke",
    runtimeBackend: "runc",
    cpuCount: "2",
    memory: "4g",
    pidsLimit: "2048",
    routes: [],
    gitUserName: "DIM Example",
    gitUserEmail: "example@dim.invalid",
    gitBaseUrl: "http://unused.invalid",
    projectManifestPath: "/run/dim/project.json",
    createdAt: $now,
    updatedAt: $now
  }' > "$state_root/workspaces/$workspace_name.json"
grant="$workspace_name.smoke-grant"
printf '%s\n' "$grant" > "$state_root/workspace-grants/$workspace_name"
chmod 0600 "$state_root/workspace-grants/$workspace_name"
printf '%s\n' '{"schemaVersion":1,"workspaceBackend":"runc"}' > "$state_root/dim.json"

DIM_BIN="$dim_bin" \
DIM_EXTERNAL_URL_CONFIG="$state_root/external-urls.json" \
DIM_EXTERNAL_URL_DOMAIN="host.tail.test" \
DIM_EXTERNAL_URL_PORT="$proxy_port" \
DIM_EXTERNAL_URL_LISTEN_PORT="$proxy_port" \
  bash examples/external-urls/configure-ingress.bash >/dev/null
DIM_EXTERNAL_URL_CONFIG="$state_root/external-urls.json" \
  node packages/cli/dist/cli.js external-url ingress add builtin-http \
    --name local-loopback \
    --description "loopback-only negative-test ingress" \
    --scheme http \
    --argument "{\"domain\":\"loopback.tail.test\",\"publicPort\":$loopback_port,\"listenHost\":\"127.0.0.1\",\"listenPort\":$loopback_port}" \
    >/dev/null
mkdir -p "$(dirname -- "$controller_socket")"
DIM_STATE_ROOT="$state_root" \
DIM_PLUGIN_HOME="$plugin_home" \
DIM_CONFIG_PATH="$state_root/dim.json" \
DIM_EXTERNAL_URL_CONFIG="$state_root/external-urls.json" \
  node packages/cli/dist/cli.js controller serve \
    --socket "$controller_socket" \
    >"$state_root/controller.log" 2>&1 &
controller_pid=$!

for attempt in $(seq 1 30); do
  if curl --fail --silent --unix-socket "$controller_socket" \
    -H "Authorization: Bearer $grant" \
    "http://dim-controller/api" >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    cat "$state_root/controller.log" >&2
    exit 1
  fi
  sleep 1
done

run_dim() {
  DIM_STATE_ROOT="$state_root" \
  DIM_CONFIG_PATH="$state_root/dim.json" \
  DIM_CONTROLLER_SOCKET="$controller_socket" \
    node packages/cli/dist/cli.js "$@"
}

echo "[external-url-example] discover plugin routes and request nested URLs"
discovery="$(run_dim external-url discover --workspace "$workspace_name" --json)"
printf '%s' "$discovery" | jq -e \
  '.[] | select(.name == "local-http")' \
  >/dev/null

DIM_BIN="$dim_bin" \
DIM_STATE_ROOT="$state_root" \
DIM_CONFIG_PATH="$state_root/dim.json" \
DIM_CONTROLLER_SOCKET="$controller_socket" \
  bash examples/external-urls/create-urls.bash "$workspace_name" \
  >"$state_root/create-urls.log"
created_urls="$(run_dim external-url list --workspace "$workspace_name" --json)"
dev_created="$(printf '%s' "$created_urls" | jq -ec '.urls[] | select(.service == "dev")')"
deep_created="$(printf '%s' "$created_urls" | jq -ec '.urls[] | select(.service == "deep")')"
loopback_created="$(
  run_dim external-url request \
    --workspace "$workspace_name" \
    --ingress local-loopback \
    --name loopback \
    --container dev \
    --port 8080 \
    --json
)"
dev_url="$(printf '%s' "$dev_created" | jq -er '.url')"
deep_url="$(printf '%s' "$deep_created" | jq -er '.url')"
loopback_url="$(printf '%s' "$loopback_created" | jq -er '.urls[0].url')"

echo "[external-url-example] resolve wildcard URLs through dnsmasq"
gateway="$(docker network inspect "$client_network" --format '{{(index .IPAM.Config 0).Gateway}}')"

echo "[external-url-example] reconcile Cloudflare-compatible API state into authoritative DNS"
cloudflare_config="$state_root/cloudflare-external-urls.json"
cloudflare_output="$state_root/cloudflare-deployment"
cloudflare_cli=(
  env
  "CF_SMOKE_TOKEN=smoke-token"
  "DIM_CLOUDFLARE_API_BASE=http://127.0.0.1:$cloudflare_mock_port/client/v4"
  "DIM_EXTERNAL_URL_CONFIG=$cloudflare_config"
  node packages/cli/dist/cli.js external-url
)
"${cloudflare_cli[@]}" add-provider cloudflare local-cloudflare \
  --zone smoke.test \
  --record-type A \
  --target "$gateway" \
  --credential-env CF_SMOKE_TOKEN >/dev/null
"${cloudflare_cli[@]}" ingress add caddy \
  --name local-https \
  --description "local Cloudflare-compatible DNS smoke ingress" \
  --scheme https \
  --argument '{"domain":"dev.smoke.test","listenHost":"127.0.0.1","listenPort":9443,"provider":"local-cloudflare"}' >/dev/null
"${cloudflare_cli[@]}" ingress setup local-https --output "$cloudflare_output" >/dev/null
test -f "$cloudflare_output/local-https/Caddyfile"
docker build --quiet --tag "$caddy_image" "$cloudflare_output/local-https" >/dev/null
if ! docker run --rm \
  --env CF_SMOKE_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --volume "$cloudflare_output/local-https/Caddyfile:/etc/caddy/Caddyfile:ro" \
  "$caddy_image" caddy validate --config /etc/caddy/Caddyfile \
  >"$state_root/caddy-validate.log" 2>&1; then
  cat "$state_root/caddy-validate.log" >&2
  exit 1
fi
coredns_ip="$(docker container inspect "$coredns_container" \
  --format "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}")"
for attempt in $(seq 1 30); do
  if docker run --rm --network "$network" --dns "$coredns_ip" \
    busybox@sha256:9532d8c39891ca2ecde4d30d7710e01fb739c87a8b9299685c63704296b16028 \
    nslookup probe.dev.smoke.test 2>/dev/null | grep -Fq "$gateway"; then
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    docker logs "$coredns_container" >&2
    exit 1
  fi
  sleep 1
done
"${cloudflare_cli[@]}" ingress remove local-https --cleanup-dns >/dev/null
for attempt in $(seq 1 30); do
  if ! docker run --rm --network "$network" --dns "$coredns_ip" \
    busybox@sha256:9532d8c39891ca2ecde4d30d7710e01fb739c87a8b9299685c63704296b16028 \
    nslookup probe.dev.smoke.test >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    echo "Cloudflare mock DNS record remained after cleanup" >&2
    exit 1
  fi
  sleep 1
done

docker run --detach \
  --name "$dns_container" \
  --network "$client_network" \
  --cap-add NET_ADMIN \
  strm/dnsmasq@sha256:dcf4c0aeb69ea6b9bca81314449d732ecd2ea021588d8a34d4be7c2304f89a39 \
  --address="/.host.tail.test/$gateway" \
  --address="/.loopback.tail.test/$gateway" \
  --log-facility=- >/dev/null
dns_ip="$(docker container inspect "$dns_container" --format "{{(index .NetworkSettings.Networks \"$client_network\").IPAddress}}")"

external_curl() {
  docker run --rm --network "$client_network" --dns "$dns_ip" \
    curlimages/curl:8.12.1 "$@"
}

test "$(external_curl \
  --fail --silent --show-error "$dev_url")" = "hello-from-dev"
test "$(external_curl \
  --fail --silent --show-error "$deep_url")" = "hello-from-deep"
test "$(external_curl --silent --output /dev/null --write-out '%{http_code}' \
  "http://unknown--$workspace_name.host.tail.test:$proxy_port/")" = "404"
if external_curl --fail --silent --show-error "$loopback_url" >/dev/null 2>&1; then
  echo "loopback-only ingress was reachable from the external client network" >&2
  exit 1
fi

dev_id="$(printf '%s' "$dev_created" | jq -er '.id')"
run_dim external-url revoke "$dev_id" --workspace "$workspace_name"
test "$(external_curl --silent --output /dev/null --write-out '%{http_code}' \
  "$dev_url")" = "404"

run_dim external-url revoke \
  "$(printf '%s' "$deep_created" | jq -er '.id')" \
  --workspace "$workspace_name"
run_dim external-url revoke \
  "$(printf '%s' "$loopback_created" | jq -er '.urls[0].id')" \
  --workspace "$workspace_name"

echo "external-url-example-smoke-ok"
