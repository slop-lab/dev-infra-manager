#!/usr/bin/env bash
set -euo pipefail

suffix="$PPID-$$"
network="dim-ext-$suffix"
root_container="dim-ext-root-$suffix"
dns_container="dim-ext-dns-$suffix"
workspace_name="external-$suffix"
state_root="$(mktemp -d /tmp/dim-external-state.XXXXXX)"
plugin_home="$(mktemp -d /tmp/dim-external-plugins.XXXXXX)"
pack_root="$(mktemp -d /tmp/dim-external-packs.XXXXXX)"
controller_pid=""

available_port() {
  node -e '
    const server = require("node:net").createServer();
    server.listen(0, "127.0.0.1", () => {
      console.log(server.address().port);
      server.close();
    });
  '
}

api_port="$(available_port)"
proxy_port="$(available_port)"

cleanup() {
  if [[ -n "$controller_pid" ]]; then
    kill "$controller_pid" >/dev/null 2>&1 || true
    wait "$controller_pid" 2>/dev/null || true
  fi
  docker container rm --force "$dns_container" >/dev/null 2>&1 || true
  docker container rm --force "$root_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  find "$state_root" "$plugin_home" "$pack_root" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

echo "[external-url-example] build local packages and workspace image"
pnpm run workspace:build >/dev/null
docker build \
  --build-arg "DIM_UID=$(id -u)" \
  --build-arg "DIM_GID=$(id -g)" \
  --tag dev-infra-project-workspace:latest \
  images/project-workspace >/dev/null

npm pack ./packages/core/dist --pack-destination "$pack_root" --silent >/dev/null
npm pack ./packages/external-urls/dist --pack-destination "$pack_root" --silent >/dev/null
npm install --prefix "$plugin_home" --silent \
  "$pack_root/slop-lab-dev-infra-manager-core-0.2.0.tgz" \
  "$pack_root/slop-lab-dim-plugin-external-urls-0.4.0.tgz"
jq -n '{schemaVersion:1,plugins:["@slop-lab/dim-plugin-external-urls"]}' \
  > "$plugin_home/plugins.json"

echo "[external-url-example] start project-root, dev, and deep containers"
docker network create "$network" >/dev/null
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
    wget -qO- http://127.0.0.1:8080 | grep -qx hello-from-dev; then
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

ingresses="$(jq -cn \
  --argjson proxyPort "$proxy_port" \
  '{
    "local-http": {
      description: "dnsmasq host wildcard HTTP ingress",
      scheme: "http",
      domain: "host.tail.test",
      port: $proxyPort,
      listenHost: "0.0.0.0",
      listenPort: $proxyPort,
      upstreamMode: "container-ip"
    }
  }')"
DIM_STATE_ROOT="$state_root" \
DIM_PLUGIN_HOME="$plugin_home" \
DIM_CONFIG_PATH="$state_root/dim.json" \
DIM_EXTERNAL_URL_INGRESSES="$ingresses" \
  node packages/dim-cli/dist/cli.js controller serve \
    --host 127.0.0.1 --port "$api_port" \
    >"$state_root/controller.log" 2>&1 &
controller_pid=$!

for attempt in $(seq 1 30); do
  if curl --fail --silent \
    -H "Authorization: Bearer $grant" \
    "http://127.0.0.1:$api_port/api" >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    cat "$state_root/controller.log" >&2
    exit 1
  fi
  sleep 1
done

echo "[external-url-example] discover plugin routes and request nested URLs"
discovery="$(
  curl --fail --silent --show-error \
    -H "Authorization: Bearer $grant" \
    "http://127.0.0.1:$api_port/api"
)"
printf '%s' "$discovery" | jq -e \
  '.routes[] | select(.path == "/api/urls") | .discovery.ingresses[] | select(.name == "local-http")' \
  >/dev/null

create_url() {
  local service="$1"
  local containers="$2"
  local port="$3"
  curl --fail --silent --show-error \
    -H "Authorization: Bearer $grant" \
    -H "Content-Type: application/json" \
    --data "$(jq -n \
      --arg service "$service" \
      --argjson containers "$containers" \
      --argjson port "$port" \
      '{
        ingress: "local-http",
        service: $service,
        target: {containers: $containers, port: $port, protocol: "http"}
      }')" \
    "http://127.0.0.1:$api_port/api/urls"
}

dev_created="$(create_url dev '["dev"]' 8080)"
deep_created="$(create_url deep '["dev","deep"]' 5678)"
dev_url="$(printf '%s' "$dev_created" | jq -er '.urls[0].url')"
deep_url="$(printf '%s' "$deep_created" | jq -er '.urls[0].url')"

echo "[external-url-example] resolve wildcard URLs through dnsmasq"
gateway="$(docker network inspect "$network" --format '{{(index .IPAM.Config 0).Gateway}}')"
docker run --detach \
  --name "$dns_container" \
  --network "$network" \
  --cap-add NET_ADMIN \
  strm/dnsmasq@sha256:dcf4c0aeb69ea6b9bca81314449d732ecd2ea021588d8a34d4be7c2304f89a39 \
  --address="/.host.tail.test/$gateway" \
  --log-facility=- >/dev/null
dns_ip="$(docker container inspect "$dns_container" --format "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}")"

test "$(docker run --rm --network "$network" --dns "$dns_ip" curlimages/curl:8.12.1 \
  --fail --silent --show-error "$dev_url")" = "hello-from-dev"
test "$(docker run --rm --network "$network" --dns "$dns_ip" curlimages/curl:8.12.1 \
  --fail --silent --show-error "$deep_url")" = "hello-from-deep"

for id in \
  "$(printf '%s' "$dev_created" | jq -er '.urls[0].id')" \
  "$(printf '%s' "$deep_created" | jq -er '.urls[0].id')"; do
  curl --fail --silent --show-error \
    --request DELETE \
    -H "Authorization: Bearer $grant" \
    "http://127.0.0.1:$api_port/api/urls/$id" >/dev/null
done

echo "external-url-example-smoke-ok"
