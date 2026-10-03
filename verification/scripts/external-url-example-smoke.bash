#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
suffix="$PPID-$$"
network="dim-ext-$suffix"
client_network="dim-ext-client-$suffix"
root_container="dim-ext-root-$suffix"
dns_container="dim-ext-dns-$suffix"
coredns_container="dim-ext-coredns-$suffix"
workspace_name="external-$suffix"
workspace_id="$(printf 'A%.0s' {1..43})"
grant="$(node -e 'process.stdout.write(Buffer.from(process.argv[1]).toString("base64url"))' "$workspace_name").$workspace_id.$(printf 'B%.0s' {1..43})"
state_root="$(mktemp -d /tmp/dim-external-state.XXXXXX)"
project_id="external-example-project-id"
root_commit="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
protected_root="$state_root/assets/project-roots/$project_id/$root_commit"
plugin_home="$(mktemp -d /tmp/dim-external-plugins.XXXXXX)"
cli_home="$(mktemp -d /tmp/dim-external-cli.XXXXXX)"
pack_root="$(mktemp -d /tmp/dim-external-packs.XXXXXX)"
repository_root="$(mktemp -d /tmp/dim-external-repositories.XXXXXX)"
controller_pid=""
controller_runtime_directory=""
cloudflare_mock_pid=""
workspace_image=""

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
admin_socket="$state_root/controller/admin.sock"

cleanup() {
  local managed_controller_pid=""
  if [[ -n "$controller_runtime_directory" && -f "$controller_runtime_directory/controller.pid" ]]; then
    managed_controller_pid="$(cat "$controller_runtime_directory/controller.pid")"
  fi
  if [[ -n "$managed_controller_pid" && "$managed_controller_pid" != "$controller_pid" ]]; then
    kill "$managed_controller_pid" >/dev/null 2>&1 || true
  fi
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
  docker container rm --force dim-caddy-local-https >/dev/null 2>&1 || true
  docker container rm --force "$root_container" >/dev/null 2>&1 || true
  if [[ -n "$workspace_image" ]]; then
    docker run --rm --entrypoint rm \
      --mount type=bind,src=/tmp,dst=/host \
      "$workspace_image" -rf "/host/${protected_root#/tmp/}" >/dev/null 2>&1 || true
  fi
  docker network rm "$network" >/dev/null 2>&1 || true
  docker network rm "$client_network" >/dev/null 2>&1 || true
  find "$state_root" "$plugin_home" "$cli_home" "$pack_root" "$repository_root" \
    -depth -delete 2>/dev/null || true
}
report_error() {
  if [[ -n "$controller_runtime_directory" && -d "$controller_runtime_directory" ]]; then
    find "$controller_runtime_directory" -maxdepth 1 -printf '%f\n' >&2
    [[ ! -f "$controller_runtime_directory/controller.pid" ]] || {
      printf 'controller pid: ' >&2
      cat "$controller_runtime_directory/controller.pid" >&2
    }
    [[ ! -f "$controller_runtime_directory/controller.log" ]] || tail -n 80 "$controller_runtime_directory/controller.log" >&2
  fi
}
trap report_error ERR
trap cleanup EXIT

bash "$script_dir/container-integration-preflight.bash"

echo "[external-url-example] build local packages and workspace image"
local_version="$(bash "$script_dir/local-build-version.bash")"
workspace_image="dev-infra-project-workspace:$local_version"
bash verification/scripts/pack-local-packages.bash "$pack_root" >/dev/null
bash examples/features/external-urls/create-repository.bash \
  "$repository_root/materialized" >/dev/null
docker build \
  --quiet \
  --build-arg "DIM_UID=$(id -u)" \
  --build-arg "DIM_GID=$(id -g)" \
  --tag "$workspace_image" \
  --file core/images/project-workspace/Dockerfile \
  . >/dev/null
tar -C "$repository_root/materialized/root" -cf - . | \
  docker run --rm --interactive --entrypoint sh \
    --mount type=bind,src=/tmp,dst=/host \
    "$workspace_image" -c 'mkdir -p "$1" && tar -xf - -C "$1"' \
    sh "/host/${protected_root#/tmp/}"

package_archive() {
  local package_name="$1"
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [root, name] = process.argv.slice(1);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "packages.json")));
    const entry = manifest.packages.find((item) => item.name === name);
    if (!entry) throw new Error(`package not found in manifest: ${name}`);
    process.stdout.write(path.join(root, entry.file));
  ' "$pack_root" "$package_name"
}

npm install --prefix "$cli_home" --silent \
  "$(package_archive @slop-lab/dim-controller-proxy)" \
  "$(package_archive @slop-lab/dim-core)" \
  "$(package_archive @slop-lab/dim-contracts-external-url)" \
  "$(package_archive @slop-lab/dim-plugin-dns-cloudflare)" \
  "$(package_archive @slop-lab/dim-cli)"
npm install --prefix "$plugin_home" --silent \
  "$(package_archive @slop-lab/dim-controller-proxy)" \
  "$(package_archive @slop-lab/dim-core)" \
  "$(package_archive @slop-lab/dim-contracts-external-url)" \
  "$(package_archive @slop-lab/dim-plugin-dns-cloudflare)" \
  "$(package_archive @slop-lab/dim-plugin-host-mirrors)" \
  "$(package_archive @slop-lab/dim-plugin-external-urls)"
jq -n '{schemaVersion:1,plugins:[
  "@slop-lab/dim-plugin-dns-cloudflare",
  "@slop-lab/dim-plugin-host-mirrors",
  "@slop-lab/dim-plugin-external-urls"
]}' \
  > "$plugin_home/plugins.json"
dim_bin="$cli_home/node_modules/.bin/dim"

echo "[external-url-example] load the freshly installed plugin before any ingress exists"
printf '%s\n' '{"schemaVersion":1,"workspaceBackend":"sysbox"}' > "$state_root/dim.json"
controller_runtime_directory="$(
  DIM_STATE_ROOT="$state_root" \
  DIM_CONFIG_PATH="$state_root/dim.json" \
    node --input-type=module -e '
      import { pathToFileURL } from "node:url";
      const { lifecycleOptions } = await import(pathToFileURL(process.argv[1]).href);
      process.stdout.write(lifecycleOptions().controllerRuntimeDirectory);
    ' "$cli_home/node_modules/@slop-lab/dim-core/index.js"
)"
DIM_STATE_ROOT="$state_root" \
DIM_PLUGIN_HOME="$plugin_home" \
DIM_CONFIG_PATH="$state_root/dim.json" \
DIM_EXTERNAL_URL_CONFIG="$state_root/external-urls.json" \
DIM_CLOUDFLARE_API_BASE="http://127.0.0.1:$cloudflare_mock_port/client/v4" \
DIM_CONTROLLER_SOCKET="$controller_socket" \
DIM_ADMIN_CONTROLLER_SOCKET="$admin_socket" \
	  "$dim_bin" plugin list --json \
	  >"$state_root/plugin-list.json"
jq -e '.plugins | index("@slop-lab/dim-plugin-external-urls") != null' "$state_root/plugin-list.json" >/dev/null
jq -e '.plugins | index("@slop-lab/dim-plugin-dns-cloudflare") != null' "$state_root/plugin-list.json" >/dev/null
test ! -e "$state_root/external-urls.json"

workspace_label_module="$cli_home/node_modules/@slop-lab/dim-core/workspaceResourceOwnership.js"
workspace_labels_output="$(node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const [modulePath, containerName, name, workspaceId, projectId] = process.argv.slice(1);
  const { workspaceContainerLabels } = await import(pathToFileURL(modulePath).href);
  const labels = workspaceContainerLabels({
    containerName,
    name,
    workspaceId,
    projectName: "external-example",
    projectId,
    rootRepositoryAlias: "root",
    runtimeBackend: "sysbox",
    dockerVolumeName: "unused-in-smoke"
  });
  process.stdout.write(labels.join("\n"));
' "$workspace_label_module" "$root_container" "$workspace_name" "$workspace_id" "$project_id")"
mapfile -t workspace_labels <<<"$workspace_labels_output"
workspace_label_arguments=()
for label in "${workspace_labels[@]}"; do
  workspace_label_arguments+=(--label "$label")
done

echo "[external-url-example] start project-root, dev, and deep containers"
docker network create "$network" >/dev/null
docker network create "$client_network" >/dev/null
mkdir -p "$state_root/cloudflare-zones"
mkdir -p "$(dirname -- "$controller_socket")"
CF_MOCK_PORT="$cloudflare_mock_port" \
CF_MOCK_ZONE="smoke.test" \
CF_MOCK_ZONE_FILE="$state_root/cloudflare-zones/smoke.test.zone" \
  node verification/scripts/cloudflare-dns-mock.mjs >"$state_root/cloudflare-mock.log" 2>&1 &
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
  --volume "$PWD/verification/scripts/fixtures/external-url-cloudflare/Corefile:/Corefile:ro" \
  --volume "$state_root/cloudflare-zones:/zones:ro" \
  coredns/coredns@sha256:900f9c109f7a33545d3c811516e8376df9019147b750f5ce3e254468769176ea \
  -conf /Corefile >/dev/null
docker run --detach --privileged \
  --name "$root_container" \
  --network "$network" \
  "${workspace_label_arguments[@]}" \
  --label dim.runtime-config=9 \
  --mount "type=bind,src=$protected_root,dst=/run/dim/project-root,readonly" \
  --volume "$state_root/controller:/run/dim/controller" \
  --env DIM_CONTROLLER_SOCKET=/run/dim/controller/controller.sock \
  --env "DIM_CONTROLLER_TOKEN=$grant" \
  --env COMPOSE_PROJECT_NAME=dim-external-example \
  "$workspace_image" sleep infinity >/dev/null
test "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/run/dim/project-root"}}{{.Source}}|{{.RW}}{{end}}{{end}}' \
  "$root_container")" = "$protected_root|false"

for attempt in $(seq 1 60); do
  docker exec "$root_container" docker info >/dev/null 2>&1 && break
  if [[ "$attempt" -eq 60 ]]; then
    docker logs "$root_container" >&2
    exit 1
  fi
  sleep 1
done
docker exec "$root_container" mkdir -p /workspace/project
docker cp "$repository_root/materialized/root/." "$root_container:/workspace/project/"
echo "[external-url-example] create controller state and host ingress"
mkdir -p "$state_root/workspaces" "$state_root/workspace-grants"
now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
jq -n \
  --arg name "$workspace_name" \
  --arg container "$root_container" \
  --arg network "$network" \
  --arg now "$now" \
  --arg workspaceId "$workspace_id" \
  --arg projectId "$project_id" \
  --arg rootCommit "$root_commit" \
  '{
    schemaVersion: 8,
    workspaceId: $workspaceId,
    name: $name,
    projectId: $projectId,
    projectName: "external-example",
    rootRepositoryAlias: "root",
    rootRef: "refs/heads/main",
    rootCommit: $rootCommit,
    workspaceDataPath: "/var/lib/dim/workspace-data",
    phase: "ready",
    profiles: ["development"],
    composeProjectName: "dim-external-example",
    containerName: $container,
    networkName: $network,
    dockerVolumeName: "unused-in-smoke",
    runtimeBackend: "sysbox",
    kvm: false,
    cpuCount: "2",
    memory: "4g",
    pidsLimit: "2048",
    routes: [],
    gitUserName: "DIM Example",
    gitUserEmail: "example@dim.invalid",
    gitBaseUrl: "http://unused.invalid",
    hostAliases: {},
    projectManifestPath: "/run/dim/project.json",
    createdAt: $now,
    updatedAt: $now
  }' > "$state_root/workspaces/$workspace_name.json"
printf '%s\n' "$grant" > "$state_root/workspace-grants/$workspace_name.$workspace_id"
chmod 0600 "$state_root/workspace-grants/$workspace_name.$workspace_id"
DIM_BIN="$dim_bin" \
DIM_STATE_ROOT="$state_root" \
DIM_PLUGIN_HOME="$plugin_home" \
DIM_CONFIG_PATH="$state_root/dim.json" \
DIM_EXTERNAL_URL_CONFIG="$state_root/external-urls.json" \
DIM_CONTROLLER_SOCKET="$controller_socket" \
DIM_ADMIN_CONTROLLER_SOCKET="$admin_socket" \
DIM_EXTERNAL_URL_DOMAIN="host.tail.test" \
DIM_EXTERNAL_URL_PORT="$proxy_port" \
DIM_EXTERNAL_URL_LISTEN_PORT="$proxy_port" \
  bash examples/features/external-urls/configure-ingress.bash >/dev/null
DIM_EXTERNAL_URL_CONFIG="$state_root/external-urls.json" \
DIM_STATE_ROOT="$state_root" \
DIM_PLUGIN_HOME="$plugin_home" \
DIM_CONFIG_PATH="$state_root/dim.json" \
DIM_CONTROLLER_SOCKET="$controller_socket" \
DIM_ADMIN_CONTROLLER_SOCKET="$admin_socket" \
  node core/packages/cli/dist/cli.js external-url ingress add http \
    --name local-loopback \
    --description "loopback-only negative-test ingress" \
    --scheme http \
    --domain loopback.tail.test \
    --public-port "$loopback_port" \
    --listen-host 127.0.0.1 \
    --listen-port "$loopback_port" \
    >/dev/null
controller_pid="$(cat "$controller_runtime_directory/controller.pid")"

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

docker exec --user dim --workdir /workspace/project "$root_container" \
  sh .dim/setup.sh --profile development >/dev/null
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

run_dim() {
  DIM_STATE_ROOT="$state_root" \
  DIM_CONFIG_PATH="$state_root/dim.json" \
  DIM_CONTROLLER_SOCKET="$controller_socket" \
  DIM_ADMIN_CONTROLLER_SOCKET="$admin_socket" \
  DIM_CONTROLLER_TOKEN="$grant" \
    node core/packages/cli/dist/cli.js "$@"
}

echo "[external-url-example] discover plugin routes and request pending nested URLs"
DIM_BIN="$dim_bin" \
DIM_STATE_ROOT="$state_root" \
DIM_CONFIG_PATH="$state_root/dim.json" \
DIM_CONTROLLER_SOCKET="$controller_socket" \
DIM_ADMIN_CONTROLLER_SOCKET="$admin_socket" \
  bash examples/features/external-urls/request-urls.bash "$workspace_name" \
  >"$state_root/request-urls.log"
dev_container=dim-external-example-dev-1
test -z "$(docker exec "$root_container" docker exec "$dev_container" \
  sh -c 'printf %s "${DIM_CONTROLLER_TOKEN-}"')"
docker exec "$root_container" docker exec "$dev_container" \
  test ! -e /run/dim/controller/controller.sock
created_urls="$(run_dim external-url list --json)"
dev_created="$(printf '%s' "$created_urls" | jq -ec '.urls[] | select(.target.containers == ["dev"])')"
deep_created="$(printf '%s' "$created_urls" | jq -ec '.urls[] | select(.target.containers == ["dev","deep"])')"
test "$(printf '%s' "$dev_created" | jq -er '.approval')" = "pending"
test "$(printf '%s' "$deep_created" | jq -er '.approval')" = "pending"
test "$(printf '%s' "$dev_created" | jq -er '.subdomain')" = "${workspace_name}--0"
test "$(printf '%s' "$deep_created" | jq -er '.subdomain')" = "${workspace_name}--1"
loopback_created="$(
  run_dim external-url request \
    --ingress local-loopback \
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
cloudflare_cli=(
  env
  "CF_SMOKE_TOKEN=smoke-token"
  "DIM_CLOUDFLARE_API_BASE=http://127.0.0.1:$cloudflare_mock_port/client/v4"
  "DIM_STATE_ROOT=$state_root"
  "DIM_PLUGIN_HOME=$plugin_home"
  "DIM_CONFIG_PATH=$state_root/dim.json"
  "DIM_EXTERNAL_URL_CONFIG=$state_root/external-urls.json"
  "DIM_CONTROLLER_SOCKET=$controller_socket"
  "DIM_ADMIN_CONTROLLER_SOCKET=$admin_socket"
  node core/packages/cli/dist/cli.js external-url
)
"${cloudflare_cli[@]}" dns-provider add cloudflare \
  --name local-cloudflare \
  --credential smoke-token >/dev/null
"${cloudflare_cli[@]}" ingress add caddy \
  --name local-https \
  --description "local Cloudflare-compatible DNS smoke ingress" \
  --scheme https \
  --domain dev.smoke.test \
  --listen-host 127.0.0.1 \
  --listen-port auto \
  --dns-provider local-cloudflare \
  --dns-argument "$(jq -cn --arg value "$gateway" \
    '{zone:"smoke.test",value:$value,proxied:false}')" >/dev/null
managed_caddy="$state_root/plugins/external-urls/caddy/local-https"
test -f "$managed_caddy/Caddyfile"
test -f "$managed_caddy/.env"
test "$(docker inspect --format '{{.State.Running}}' dim-caddy-local-https)" = true
test -z "$(jq -r '.ingresses["local-https"].argument | fromjson | .internalPort // empty' \
  "$state_root/external-urls.json")"
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
test ! -e "$managed_caddy"
if docker container inspect dim-caddy-local-https >/dev/null 2>&1; then
  echo "managed Caddy container remained after ingress removal" >&2
  exit 1
fi
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
    curlimages/curl:8.12.1@sha256:94e9e444bcba979c2ea12e27ae39bee4cd10bc7041a472c4727a558e213744e6 \
    "$@"
}

test "$(external_curl --silent --output /dev/null --write-out '%{http_code}' \
  "$dev_url")" = "404"
test "$(external_curl --silent --output /dev/null --write-out '%{http_code}' \
  "$deep_url")" = "404"
dev_id="$(printf '%s' "$dev_created" | jq -er '.id')"
deep_id="$(printf '%s' "$deep_created" | jq -er '.id')"
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --unix-socket "$controller_socket" \
  --header "Authorization: Bearer $grant" \
  --request POST \
  "http://dim-controller/api/urls/$dev_id/approve")" = "404"
run_dim external-url approve "$dev_id"
run_dim external-url approve "$deep_id"
test "$(external_curl \
  --fail --silent --show-error "$dev_url")" = "hello-from-dev"
test "$(external_curl \
  --fail --silent --show-error "$deep_url")" = "hello-from-deep"
test "$(external_curl --silent --output /dev/null --write-out '%{http_code}' \
  "http://$workspace_name--unknown.host.tail.test:$proxy_port/")" = "404"
if external_curl --fail --silent --show-error "$loopback_url" >/dev/null 2>&1; then
  echo "loopback-only ingress was reachable from the external client network" >&2
  exit 1
fi

run_dim external-url revoke \
  "$(printf '%s' "$loopback_created" | jq -er '.urls[0].id')"
run_dim workspace discard "$workspace_name" --yes
test "$(external_curl --silent --output /dev/null --write-out '%{http_code}' \
  "$dev_url")" = "404"
test "$(external_curl --silent --output /dev/null --write-out '%{http_code}' \
  "$deep_url")" = "404"

echo "external-url-example-smoke-ok"
