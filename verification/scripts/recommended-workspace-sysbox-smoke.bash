#!/usr/bin/env bash
set -euo pipefail

image="${1:-dev-infra-project-workspace:$(node -p "require('./package.json').version")}" 
runtime_json="$(docker info --format '{{json .Runtimes}}')"
if ! jq -e 'has("sysbox-runc")' <<<"$runtime_json" >/dev/null; then
  printf '%s\n' 'GATE BLOCKED: Docker runtime sysbox-runc is not registered; recommended workspace isolation was not executed.' >&2
  exit 3
fi

scope="dim-recommended-smoke-$RANDOM-$$"
home="$scope-home"
checkout="$scope-checkout"
dockerdata="$scope-docker"
container="$scope-agent"
container_id=""
home_created=false
checkout_created=false
dockerdata_created=false
cleanup() {
  [[ -z "$container_id" ]] || docker container rm --force "$container_id" >/dev/null 2>&1 || true
  [[ "$home_created" != true ]] || remove_owned_volume "$home"
  [[ "$checkout_created" != true ]] || remove_owned_volume "$checkout"
  [[ "$dockerdata_created" != true ]] || remove_owned_volume "$dockerdata"
}
remove_owned_volume() {
  local volume="$1"
  [[ "$(docker volume inspect "$volume" --format '{{index .Labels "dim.smoke-scope"}}' 2>/dev/null || true)" != "$scope" ]] \
    || docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker image inspect "$image" >/dev/null
docker volume create --label dim.managed=true --label dim.owner=dim --label "dim.smoke-scope=$scope" "$home" >/dev/null
home_created=true
docker volume create --label dim.managed=true --label dim.owner=dim --label "dim.smoke-scope=$scope" "$checkout" >/dev/null
checkout_created=true
docker volume create --label dim.managed=true --label dim.owner=dim --label "dim.smoke-scope=$scope" "$dockerdata" >/dev/null
dockerdata_created=true
docker run --detach --name "$container" --runtime sysbox-runc \
  --mount "type=volume,source=$home,target=/home/dim" \
  --mount "type=volume,source=$checkout,target=/workspace" \
  --mount "type=volume,source=$dockerdata,target=/var/lib/docker" \
  --entrypoint /usr/local/bin/dim-agent-entrypoint \
  "$image" sleep infinity >/dev/null
container_id="$(docker container inspect "$container" --format '{{.Id}}')"

for _ in $(seq 1 60); do
  docker exec --user dim "$container" docker info >/dev/null 2>&1 && break
  sleep 1
done
docker exec --user dim "$container" docker info >/dev/null
docker exec --user dim "$container" docker volume create smoke-persistent >/dev/null
docker exec --user dim "$container" sh -eu -c 'printf persistent > /workspace/probe'
docker container rm --force "$container" >/dev/null
container_id=""
docker run --detach --name "$container" --runtime sysbox-runc \
  --mount "type=volume,source=$home,target=/home/dim" \
  --mount "type=volume,source=$checkout,target=/workspace" \
  --mount "type=volume,source=$dockerdata,target=/var/lib/docker" \
  --entrypoint /usr/local/bin/dim-agent-entrypoint \
  "$image" sleep infinity >/dev/null
container_id="$(docker container inspect "$container" --format '{{.Id}}')"
docker exec --user dim "$container" sh -eu -c 'test "$(cat /workspace/probe)" = persistent'
docker exec --user dim "$container" docker volume inspect smoke-persistent >/dev/null
docker inspect "$container" --format '{{json .HostConfig.Privileged}} {{.HostConfig.Runtime}}' | grep -Fx 'false sysbox-runc'
printf '%s\n' 'PASS: recommended agent used unprivileged sysbox-runc, nested Docker, and persistent named volumes.'
