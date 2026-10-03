#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_root="$(cd "$script_dir/../.." && pwd)"
source "$script_dir/lib/registry-cache-routing.bash"

usage() {
  echo "usage: $0 --sysbox|--kvm"
}

case "${1:-}" in
  --sysbox) mode=sysbox ;;
  --kvm) mode=kvm ;;
  --help) usage; exit 0 ;;
  *) usage >&2; exit 1 ;;
esac
[[ "$#" -eq 1 ]] || { usage >&2; exit 1; }

command -v docker >/dev/null || { echo "Docker is required" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "a reachable Docker daemon is required" >&2; exit 2; }
command -v node >/dev/null || { echo "Node.js is required by the registry fixture" >&2; exit 2; }
if [[ "$mode" == sysbox ]]; then
  docker info --format '{{json .Runtimes}}' | grep -q '"sysbox-runc"' || {
    echo "cache-routing-sysbox requires Docker with the sysbox-runc runtime" >&2
    exit 2
  }
else
  [[ "$(uname -m)" == x86_64 ]] || { echo "cache-routing-kvm requires x86_64" >&2; exit 2; }
  [[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] || {
    echo "cache-routing-kvm requires an accessible character /dev/kvm" >&2
    exit 2
  }
  for command in qemu-system-x86_64 qemu-img cloud-localds ssh socat; do
    command -v "$command" >/dev/null || {
      echo "cache-routing-kvm requires $command" >&2
      exit 2
    }
  done
  [[ -r "$workspace_root/.dim/qemu-verify.bash" ]] || {
    echo "cache-routing-kvm requires readable .dim/qemu-verify.bash" >&2
    exit 2
  }
fi
cleanup_exact_resources=0
dim_registry_refuse_managed_collisions
cleanup_exact_resources=1

root="$(mktemp -d "${TMPDIR:-/tmp}/dim-cache-routing-managed.XXXXXX")"
run_id="$(basename "$root")-$$"
cache="dim-registry-cache"
network="dim-control"
cache_volume="dim-registry-cache-data"
fixture_pids=()
preserve_evidence="${DIM_CACHE_ROUTING_PRESERVE_EVIDENCE:-0}"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ "$status" -ne 0 ]]; then
    docker logs "$cache" >"$root/cache-failure.log" 2>&1
  fi
  if [[ "$cleanup_exact_resources" -eq 1 ]]; then
    docker rm --force "$cache" >/dev/null 2>&1
    docker rm --force "$cache-address-reservation" >/dev/null 2>&1
    docker network rm "$network" >/dev/null 2>&1
    docker volume rm "$cache_volume" >/dev/null 2>&1
  fi
  for fixture_pid in "${fixture_pids[@]}"; do kill "$fixture_pid" >/dev/null 2>&1; done
  for fixture_pid in "${fixture_pids[@]}"; do wait "$fixture_pid" >/dev/null 2>&1; done
  if [[ "$preserve_evidence" == 1 || "$status" -ne 0 ]]; then
    echo "registry cache routing evidence: $root" >&2
  else
    rm -rf "$root"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

registry_image="$(dim_registry_cache_image "$workspace_root/plugin-host-mirrors/src/index.ts")"
docker network create --label dim.managed=true --label dim.resource=network "$network" >/dev/null
docker volume create --label dim.managed=true --label dim.resource=registry-cache-data "$cache_volume" >/dev/null
fixture_address="$(dim_registry_fixture_address)"
node -e 'if (!require("node:net").isIPv4(process.argv[1])) process.exit(1)' "$fixture_address" || {
  echo "the Docker host environment has no reachable IPv4 address" >&2
  exit 2
}
docker image pull "$registry_image" >/dev/null

start_fixture() {
  local route="$1" ready="$root/$route-ready.json" evidence="$root/$route-upstream.jsonl"
  node "$script_dir/registry-cache-evidence.mjs" --run-id "$run_id" --route "$route" \
    --bind-address "$fixture_address" --evidence-file "$evidence" --ready-file "$ready" \
    >"$root/$route-fixture.stdout" 2>"$root/$route-fixture.stderr" &
  fixture_pids+=("$!")
  for _attempt in {1..100}; do
    [[ -s "$ready" ]] && return
    kill -0 "${fixture_pids[-1]}" 2>/dev/null || { echo "$route fixture exited before readiness" >&2; return 1; }
    sleep 0.1
  done
  echo "$route fixture readiness timed out" >&2
  return 1
}

if [[ "$mode" == sysbox ]]; then
  managed_routes=(workspace agent-dind sysbox-runner)
else
  managed_routes=(qemu)
fi
for managed_route in "${managed_routes[@]}"; do
  start_fixture "$managed_route-cold"
  start_fixture "$managed_route-outage"
done
start_managed_cache() {
  local remote="$1"
  docker run --detach --name "$cache" --restart unless-stopped --network "$network" \
    --network-alias "$cache" --add-host "fixture:$fixture_address" \
    --mount "type=volume,source=$cache_volume,target=/var/lib/registry" \
    --label dim.managed=true --label dim.resource=registry-cache \
    --env "REGISTRY_PROXY_REMOTEURL=$remote" --env REGISTRY_PROXY_TTL=168h \
    --env REGISTRY_STORAGE_DELETE_ENABLED=true --env REGISTRY_LOG_LEVEL=info \
    --env OTEL_TRACES_EXPORTER=none "$registry_image" >/dev/null
}
start_managed_cache https://registry-1.docker.io
for _attempt in {1..100}; do
  docker exec "$cache" wget -qO- http://127.0.0.1:5000/v2/ >/dev/null 2>&1 && break
  sleep 0.1
done
docker exec "$cache" wget -qO- http://127.0.0.1:5000/v2/ >/dev/null 2>&1 || {
  echo "managed registry cache readiness timed out" >&2
  exit 1
}

export DIM_CACHE_ROUTING_ROUTES_ROOT="$root"
export DIM_CACHE_ROUTING_EVIDENCE_ROOT="$root"
export DIM_CACHE_ROUTING_INGRESS_EVIDENCE="$root/route-ingress.txt"
export DIM_CACHE_ROUTING_CACHE="$cache"
export DIM_CACHE_ROUTING_NETWORK="$network"
export DIM_CACHE_ROUTING_VOLUME="$cache_volume"
export DIM_CACHE_ROUTING_IMAGE="$registry_image"
export DIM_CACHE_ROUTING_FIXTURE_ADDRESS="$fixture_address"
export DIM_CI_REGISTRY_CACHE_UPSTREAM="$cache:5000"

if [[ "$mode" == sysbox ]]; then
  env DIM_DOCKER_REGISTRY_MIRROR=http://host.docker.internal:5000 \
    DIM_EXAMPLE_WORKSPACE_BACKEND=sysbox JUST_UNSTABLE=1 \
    bash "$script_dir/stateful-development-flow-smoke.bash"
  source "$script_dir/lib/registry-cache-routing-journey.bash"
  dim_cache_routing_activate_production_cache
  env DIM_EXAMPLE_WORKSPACE_BACKEND=sysbox JUST_UNSTABLE=1 \
    bash "$script_dir/ci-runner-example-smoke.bash"
else
  export DIM_QEMU_SOURCE_ROOT="$workspace_root"
  source "$script_dir/lib/registry-cache-routing-journey.bash"
  dim_cache_routing_select_route qemu
  dim_cache_routing_activate_fixture_cache
  qemu_ingress_before="$(dim_cache_routing_ingress_count)"
  qemu_upstream_before="$(dim_cache_routing_upstream_count)"
  bash "$script_dir/with-ci-registry-cache.bash" --qemu-relay \
    bash "$workspace_root/.dim/qemu-verify.bash" --cache-routing
  dim_cache_routing_assert_complete_route qemu "$qemu_ingress_before" "$qemu_upstream_before"
  dim_cache_routing_assert_no_outage_upstream
fi

route_operation_count="$(wc -l <"$DIM_CACHE_ROUTING_INGRESS_EVIDENCE" 2>/dev/null || printf '0')"
expected_operations=1
[[ "$mode" != sysbox ]] || expected_operations=6
[[ "$route_operation_count" -eq "$expected_operations" ]] || {
  echo "managed routes produced $route_operation_count phase records, expected $expected_operations" >&2
  exit 1
}
printf 'cache-routing-%s-summary routes=%s route_operations=%s\n' \
  "$mode" "${#managed_routes[@]}" "$route_operation_count"
