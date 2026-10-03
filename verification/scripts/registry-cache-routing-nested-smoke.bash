#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_root="$(cd "$script_dir/../.." && pwd)"
source "$script_dir/lib/registry-cache-routing.bash"

if [[ "${1:-}" == --help ]]; then
  echo "usage: $0 --docker-only"
  exit 0
fi
[[ "$#" -eq 1 && "$1" == --docker-only ]] || { echo "usage: $0 --docker-only" >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker is required" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "a reachable Docker daemon is required" >&2; exit 2; }
command -v node >/dev/null || { echo "Node.js is required by the registry fixture" >&2; exit 2; }
docker info --format '{{json .SecurityOptions}}' | grep -q 'name=rootless' && {
  echo "two-level cache routing requires a rootful Docker daemon with delegated cgroups" >&2
  exit 2
}
[[ "$(docker info --format '{{.CgroupDriver}}')" != none ]] || {
  echo "two-level cache routing requires Docker cgroup management" >&2
  exit 2
}

cleanup_exact_resources=0
dim_registry_refuse_managed_collisions
cleanup_exact_resources=1
root="$(mktemp -d "${TMPDIR:-/tmp}/dim-cache-routing-nested.XXXXXX")"
run_id="$(basename "$root")-$$"
network="dim-control"
cache="dim-registry-cache"
cache_volume="dim-registry-cache-data"
workspace="dim-cache-routing-workspace-$run_id"
reservation="$cache-address-reservation"
agent=agent-dind
cold_fixture_pid=""
outage_fixture_pid=""
preserve_evidence="${DIM_CACHE_ROUTING_PRESERVE_EVIDENCE:-0}"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ "$status" -ne 0 ]]; then
    docker logs "$cache" >"$root/cache-failure.log" 2>&1
    docker logs "$workspace" >"$root/workspace-failure.log" 2>&1
    docker exec "$workspace" docker logs "$agent" >"$root/agent-failure.log" 2>&1
  fi
  docker rm --force "$workspace" >/dev/null 2>&1
  if [[ "$cleanup_exact_resources" -eq 1 ]]; then
    docker rm --force "$cache" "$reservation" >/dev/null 2>&1
    docker network rm "$network" >/dev/null 2>&1
    docker volume rm "$cache_volume" >/dev/null 2>&1
  fi
  [[ -z "$cold_fixture_pid" ]] || kill "$cold_fixture_pid" >/dev/null 2>&1
  [[ -z "$outage_fixture_pid" ]] || kill "$outage_fixture_pid" >/dev/null 2>&1
  [[ -z "$cold_fixture_pid" ]] || wait "$cold_fixture_pid" >/dev/null 2>&1
  [[ -z "$outage_fixture_pid" ]] || wait "$outage_fixture_pid" >/dev/null 2>&1
  if [[ "$preserve_evidence" == 1 || "$status" -ne 0 ]]; then
    echo "nested registry cache routing evidence: $root" >&2
  else
    rm -rf "$root"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

registry_image="$(dim_registry_cache_image "$workspace_root/plugin-host-mirrors/src/index.ts")"
dind_image="docker@sha256:173f284a4299164772a90f52b373e73e087583c0963f1334c9995f190ef6f3f5"
fixture_address="$(dim_registry_fixture_address)"
node -e 'if (!require("node:net").isIPv4(process.argv[1])) process.exit(1)' "$fixture_address" || {
  echo "the Docker host environment has no reachable IPv4 address" >&2
  exit 2
}
docker image pull "$registry_image" >/dev/null
docker image pull "$dind_image" >/dev/null

start_fixture() {
  local route="$1" ready="$root/$route-ready.json" evidence="$root/$route-upstream.jsonl"
  node "$script_dir/registry-cache-evidence.mjs" --run-id "$run_id" --route "$route" \
    --bind-address "$fixture_address" --evidence-file "$evidence" --ready-file "$ready" \
    >"$root/$route-fixture.stdout" 2>"$root/$route-fixture.stderr" &
  if [[ "$route" == cold ]]; then cold_fixture_pid=$!; else outage_fixture_pid=$!; fi
  for _attempt in {1..100}; do
    [[ -s "$ready" ]] && return
    sleep 0.1
  done
  echo "$route fixture readiness timed out" >&2
  return 1
}
start_fixture cold
start_fixture outage
cold_ready="$root/cold-ready.json"
cold_evidence="$root/cold-upstream.jsonl"
cold_port="$(dim_registry_fixture_field "$cold_ready" port)"
cold_repository="$(dim_registry_fixture_field "$cold_ready" repository)"
cold_ref="docker.io/$cold_repository@$(dim_registry_fixture_field "$cold_ready" manifest_digest)"
outage_ready="$root/outage-ready.json"
outage_evidence="$root/outage-upstream.jsonl"
outage_repository="$(dim_registry_fixture_field "$outage_ready" repository)"
outage_ref="docker.io/$outage_repository@$(dim_registry_fixture_field "$outage_ready" manifest_digest)"

docker network create --label dim.verification=cache-routing "$network" >/dev/null
docker volume create --label dim.verification=cache-routing "$cache_volume" >/dev/null
start_cache() {
  docker run --detach --name "$cache" --network "$network" --network-alias "$cache" \
    --add-host "fixture:$fixture_address" \
    --mount "type=volume,source=$cache_volume,target=/var/lib/registry" \
    --label dim.verification=cache-routing \
    --env "REGISTRY_PROXY_REMOTEURL=http://fixture:$cold_port" \
    --env REGISTRY_PROXY_TTL=168h --env REGISTRY_STORAGE_DELETE_ENABLED=true \
    --env REGISTRY_LOG_LEVEL=info --env OTEL_TRACES_EXPORTER=none \
    "$registry_image" >/dev/null
}
start_cache

docker run --detach --name "$workspace" --privileged --network "$network" \
  --add-host registry-1.docker.io:127.0.0.1 --add-host auth.docker.io:127.0.0.1 \
  --label dim.verification=cache-routing --entrypoint sh "$dind_image" -c '
    dockerd --host=unix:///var/run/docker.sock --storage-driver=vfs \
      --registry-mirror=http://dim-registry-cache:5000 \
      --insecure-registry=dim-registry-cache:5000 >/tmp/workspace-dockerd.log 2>&1 &
    for attempt in $(seq 1 200); do docker info >/dev/null 2>&1 && break; sleep 0.1; done
    docker info >/dev/null 2>&1 || { cat /tmp/workspace-dockerd.log >&2; exit 1; }
    nc -lk -p 5000 -e nc dim-registry-cache 5000 &
    echo $! >/tmp/dim-ci-registry-cache-relay.pid
    exec sleep infinity
  ' >/dev/null
for _attempt in {1..200}; do
  docker exec "$workspace" docker info >/dev/null 2>&1 && break
  sleep 0.1
done
docker exec "$workspace" docker info >/dev/null 2>&1 || { echo "workspace-like Docker daemon readiness timed out" >&2; exit 1; }
docker exec "$workspace" docker info --format '{{json .RegistryConfig.Mirrors}}' | grep -Fq 'http://dim-registry-cache:5000/'
for _attempt in {1..100}; do
  docker exec "$workspace" wget -qO- http://127.0.0.1:5000/v2/ >/dev/null 2>&1 && break
  sleep 0.1
done
docker exec "$workspace" wget -qO- http://127.0.0.1:5000/v2/ >/dev/null 2>&1 || {
  echo "workspace-local registry relay readiness timed out" >&2
  exit 1
}

docker image save "$dind_image" | docker exec -i "$workspace" docker image load >/dev/null
docker exec "$workspace" docker run --detach --name "$agent" --privileged \
  --add-host host.docker.internal:host-gateway \
  --add-host registry-1.docker.io:127.0.0.1 --add-host auth.docker.io:127.0.0.1 \
  --entrypoint dockerd "$dind_image" \
  --host=unix:///var/run/docker.sock --storage-driver=vfs \
  --iptables=false --ip6tables=false --bridge=none --ip-forward=false --ip-masq=false \
  --registry-mirror=http://host.docker.internal:5000 \
  --insecure-registry=host.docker.internal:5000 >/dev/null
for _attempt in {1..200}; do
  docker exec "$workspace" docker exec "$agent" docker info >/dev/null 2>&1 && break
  sleep 0.1
done
docker exec "$workspace" docker exec "$agent" docker info >/dev/null 2>&1 || {
  echo "nested agent-like Docker daemon readiness timed out" >&2
  exit 1
}
docker exec "$workspace" docker exec "$agent" docker info --format '{{json .RegistryConfig.Mirrors}}' |
  grep -Fq 'http://host.docker.internal:5000/'

nested_docker() { docker exec "$workspace" docker exec "$agent" docker "$@"; }
cache_ingress_count() {
  docker logs "$cache" >"$root/cache-current.log" 2>&1
  dim_registry_cache_ingress_count "$root/cache-current.log" "$cold_repository"
}
artifact_count() { dim_registry_artifact_count "$cold_evidence" "$cold_repository"; }

ingress_before="$(cache_ingress_count)"
upstream_before="$(artifact_count)"
nested_docker pull "$cold_ref" >"$root/cold-pull.log" 2>&1
cold_ingress="$(cache_ingress_count)"
cold_upstream="$(artifact_count)"
[[ "$((cold_ingress - ingress_before))" -gt 0 && "$((cold_upstream - upstream_before))" -eq 3 ]] || {
  echo "nested cold pull did not produce cache ingress and exactly three upstream artifacts" >&2
  exit 1
}
nested_docker image rm "$cold_ref" >/dev/null
ingress_before="$cold_ingress"
upstream_before="$cold_upstream"
nested_docker pull "$cold_ref" >"$root/warm-pull.log" 2>&1
warm_ingress="$(cache_ingress_count)"
warm_upstream="$(artifact_count)"
[[ "$((warm_ingress - ingress_before))" -gt 0 && "$((warm_upstream - upstream_before))" -eq 0 ]] || {
  echo "nested warm pull did not use cached artifacts" >&2
  exit 1
}

previous_cache_address="$(docker inspect --format "{{with index .NetworkSettings.Networks \"$network\"}}{{.IPAddress}}{{end}}" "$cache")"
docker rm --force "$cache" >/dev/null
docker run --detach --name "$reservation" --network "$network" --ip "$previous_cache_address" \
  --label dim.verification=cache-routing --entrypoint sleep "$dind_image" infinity >/dev/null
start_cache
replacement_cache_address="$(docker inspect --format "{{with index .NetworkSettings.Networks \"$network\"}}{{.IPAddress}}{{end}}" "$cache")"
[[ "$replacement_cache_address" != "$previous_cache_address" ]] || {
  echo "replacement registry cache retained stale address $replacement_cache_address" >&2
  exit 1
}
docker rm --force "$reservation" >/dev/null
for _attempt in {1..100}; do
  docker exec "$workspace" wget -qO- http://127.0.0.1:5000/v2/ >/dev/null 2>&1 && break
  sleep 0.1
done
nested_docker image rm "$cold_ref" >/dev/null
upstream_before="$(artifact_count)"
nested_docker pull "$cold_ref" >"$root/replacement-pull.log" 2>&1
replacement_ingress="$(cache_ingress_count)"
replacement_upstream="$(artifact_count)"
[[ "$replacement_ingress" -gt 0 && "$((replacement_upstream - upstream_before))" -eq 0 ]] || {
  echo "nested replacement pull did not follow the cache alias" >&2
  exit 1
}

nested_docker image rm "$cold_ref" >/dev/null
docker exec "$workspace" sh -c 'kill "$(cat /tmp/dim-ci-registry-cache-relay.pid)"'
set +e
nested_docker pull "$outage_ref" >"$root/outage-pull.log" 2>&1
outage_status=$?
set -e
[[ "$outage_status" -ne 0 ]] || { echo "nested outage pull unexpectedly succeeded" >&2; exit 1; }
dim_registry_assert_loopback_fallback "$root/outage-pull.log"
outage_upstream_requests="$(dim_registry_request_count "$outage_evidence")"
[[ "$outage_upstream_requests" -eq 0 ]] || { echo "nested outage bypassed the workspace relay" >&2; exit 1; }

printf 'nested-cache-routing-summary cold_upstream_delta=3 warm_upstream_delta=0 replacement_address=%s replacement_upstream_delta=0 outage_status=%s outage_upstream_requests=%s\n' \
  "$replacement_cache_address" "$outage_status" "$outage_upstream_requests"
echo "registry-cache-routing-nested-smoke-ok"
