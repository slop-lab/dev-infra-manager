#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_root="$(cd "$script_dir/../.." && pwd)"
source "$script_dir/lib/registry-cache-routing.bash"

if [[ "${1:-}" == "--help" ]]; then
  echo "usage: $0 --docker-only"
  exit 0
fi
[[ "$#" -eq 1 && "$1" == "--docker-only" ]] || {
  echo "usage: $0 --docker-only" >&2
  exit 1
}
command -v docker >/dev/null || { echo "Docker is required" >&2; exit 2; }
docker info >/dev/null 2>&1 || { echo "a reachable Docker daemon is required" >&2; exit 2; }
command -v node >/dev/null || { echo "Node.js is required by the registry fixture" >&2; exit 1; }

root="$(mktemp -d "${TMPDIR:-/tmp}/dim-cache-routing.XXXXXX")"
run_id="$(basename "$root")-$$"
network="dim-cache-routing-$run_id"
cache="dim-cache-routing-cache-$run_id"
client="dim-cache-routing-client-$run_id"
address_reservation="dim-cache-routing-address-reservation-$run_id"
cache_volume="dim-cache-routing-data-$run_id"
cold_fixture_pid=""
outage_fixture_pid=""
preserve_evidence="${DIM_CACHE_ROUTING_PRESERVE_EVIDENCE:-0}"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ "$status" -ne 0 ]]; then
    docker logs "$cache" >"$root/cache-failure.log" 2>&1
    docker logs "$client" >"$root/client-failure.log" 2>&1
  fi
  docker rm --force "$cache" "$client" "$address_reservation" >/dev/null 2>&1
  docker network rm "$network" >/dev/null 2>&1
  docker volume rm "$cache_volume" >/dev/null 2>&1
  [[ -z "$cold_fixture_pid" ]] || kill "$cold_fixture_pid" >/dev/null 2>&1
  [[ -z "$outage_fixture_pid" ]] || kill "$outage_fixture_pid" >/dev/null 2>&1
  [[ -z "$cold_fixture_pid" ]] || wait "$cold_fixture_pid" >/dev/null 2>&1
  [[ -z "$outage_fixture_pid" ]] || wait "$outage_fixture_pid" >/dev/null 2>&1
  if [[ "$preserve_evidence" == "1" || "$status" -ne 0 ]]; then
    echo "registry cache routing evidence: $root" >&2
  else
    rm -rf "$root"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

registry_source="$workspace_root/plugin-host-mirrors/src/index.ts"
registry_image="$(dim_registry_cache_image "$registry_source")"
dind_image="docker@sha256:173f284a4299164772a90f52b373e73e087583c0963f1334c9995f190ef6f3f5"
fixture_address="$(dim_registry_fixture_address)"
node -e 'if (!require("node:net").isIPv4(process.argv[1])) process.exit(1)' "$fixture_address" || {
  echo "the Docker host environment has no reachable IPv4 address" >&2
  exit 2
}
docker image pull "$registry_image" >/dev/null
docker image pull "$dind_image" >/dev/null

cold_ready="$root/cold-ready.json"
cold_evidence="$root/cold-upstream.jsonl"
node "$script_dir/registry-cache-evidence.mjs" \
  --run-id "$run_id" --route cold --bind-address "$fixture_address" \
  --evidence-file "$cold_evidence" --ready-file "$cold_ready" \
  >"$root/cold-fixture.stdout" 2>"$root/cold-fixture.stderr" &
cold_fixture_pid=$!
for _attempt in {1..100}; do
  [[ -s "$cold_ready" ]] && break
  kill -0 "$cold_fixture_pid" 2>/dev/null || { echo "cold fixture exited before readiness" >&2; exit 1; }
  sleep 0.1
done
[[ -s "$cold_ready" ]] || { echo "cold fixture readiness timed out" >&2; exit 1; }
cold_port="$(dim_registry_fixture_field "$cold_ready" port)"
cold_repository="$(dim_registry_fixture_field "$cold_ready" repository)"
cold_digest="$(dim_registry_fixture_field "$cold_ready" manifest_digest)"
cold_ref="docker.io/$cold_repository@$cold_digest"

outage_ready="$root/outage-ready.json"
outage_evidence="$root/outage-upstream.jsonl"
node "$script_dir/registry-cache-evidence.mjs" \
  --run-id "$run_id" --route outage --bind-address "$fixture_address" \
  --evidence-file "$outage_evidence" --ready-file "$outage_ready" \
  >"$root/outage-fixture.stdout" 2>"$root/outage-fixture.stderr" &
outage_fixture_pid=$!
for _attempt in {1..100}; do
  [[ -s "$outage_ready" ]] && break
  kill -0 "$outage_fixture_pid" 2>/dev/null || { echo "outage fixture exited before readiness" >&2; exit 1; }
  sleep 0.1
done
[[ -s "$outage_ready" ]] || { echo "outage fixture readiness timed out" >&2; exit 1; }
outage_repository="$(dim_registry_fixture_field "$outage_ready" repository)"
outage_digest="$(dim_registry_fixture_field "$outage_ready" manifest_digest)"
outage_ref="docker.io/$outage_repository@$outage_digest"

docker network create --label dim.verification=cache-routing "$network" >/dev/null
docker volume create --label dim.verification=cache-routing "$cache_volume" >/dev/null
docker run --detach --name "$cache" --network bridge \
  --add-host "fixture:$fixture_address" \
  --mount "type=volume,source=$cache_volume,target=/var/lib/registry" \
  --label dim.verification=cache-routing \
  --env "REGISTRY_PROXY_REMOTEURL=http://fixture:$cold_port" \
  --env REGISTRY_PROXY_TTL=168h \
  --env REGISTRY_STORAGE_DELETE_ENABLED=true \
  --env REGISTRY_LOG_LEVEL=info \
  --env OTEL_TRACES_EXPORTER=none \
  "$registry_image" >/dev/null
docker network connect --alias registry-cache "$network" "$cache"

docker run --detach --name "$client" --network "$network" \
  --add-host registry-1.docker.io:127.0.0.1 \
  --add-host auth.docker.io:127.0.0.1 \
  --label dim.verification=cache-routing --entrypoint dockerd "$dind_image" \
  --host=unix:///var/run/docker.sock --storage-driver=vfs \
  --iptables=false --ip6tables=false --bridge=none --ip-forward=false --ip-masq=false \
  --registry-mirror=http://registry-cache:5000 --insecure-registry=registry-cache:5000 >/dev/null
for _attempt in {1..100}; do
  docker exec "$client" docker info >/dev/null 2>&1 && break
  sleep 0.1
done
docker exec "$client" docker info >/dev/null 2>&1 || { echo "nested Docker daemon readiness timed out" >&2; exit 2; }
for _attempt in {1..100}; do
  docker exec "$client" wget -qO- http://registry-cache:5000/v2/ >/dev/null 2>&1 && break
  [[ "$(docker inspect --format '{{.State.Running}}' "$cache")" == "true" ]] || {
    echo "registry cache exited before readiness" >&2
    exit 1
  }
  sleep 0.1
done
docker exec "$client" wget -qO- http://registry-cache:5000/v2/ >/dev/null 2>&1 || {
  echo "registry cache readiness timed out" >&2
  exit 1
}

docker exec "$client" docker pull "$cold_ref" >"$root/cold-pull.log" 2>&1
cold_manifest_count="$(dim_registry_evidence_result_count "$cold_evidence" "$cold_repository" manifest)"
cold_blob_count="$(dim_registry_evidence_result_count "$cold_evidence" "$cold_repository" blob)"
[[ "$cold_manifest_count" -eq 1 && "$cold_blob_count" -eq 2 ]] || {
  echo "cold pull upstream delta was manifest=$cold_manifest_count config=$cold_blob_count, expected manifest=1 config=2" >&2
  exit 1
}
docker logs "$cache" >"$root/cache-after-cold.log" 2>&1
cold_ingress_count="$(dim_registry_cache_ingress_count "$root/cache-after-cold.log" "$cold_repository")"
[[ "$cold_ingress_count" -gt 0 ]] || {
  echo "cold pull produced no route-local cache ingress" >&2
  exit 1
}

docker exec "$client" docker image rm "$cold_ref" >/dev/null
docker exec "$client" docker pull "$cold_ref" >"$root/warm-pull.log" 2>&1
docker logs "$cache" >"$root/cache-after-warm.log" 2>&1
warm_ingress_count="$(dim_registry_cache_ingress_count "$root/cache-after-warm.log" "$cold_repository")"
warm_manifest_count="$(dim_registry_evidence_result_count "$cold_evidence" "$cold_repository" manifest)"
warm_blob_count="$(dim_registry_evidence_result_count "$cold_evidence" "$cold_repository" blob)"
[[ "$warm_ingress_count" -gt "$cold_ingress_count" ]] || {
  echo "warm pull produced no route-local cache ingress" >&2
  exit 1
}
[[ "$warm_manifest_count" -eq "$cold_manifest_count" && "$warm_blob_count" -eq "$cold_blob_count" ]] || {
  echo "warm pull unexpectedly fetched an upstream artifact" >&2
  exit 1
}

previous_cache_address="$(docker inspect --format "{{with index .NetworkSettings.Networks \"$network\"}}{{.IPAddress}}{{end}}" "$cache")"
docker rm --force "$cache" >/dev/null
docker run --detach --name "$address_reservation" --network "$network" --ip "$previous_cache_address" \
  --label dim.verification=cache-routing --entrypoint sleep "$dind_image" infinity >/dev/null
docker run --detach --name "$cache" --network bridge \
  --add-host "fixture:$fixture_address" \
  --mount "type=volume,source=$cache_volume,target=/var/lib/registry" \
  --label dim.verification=cache-routing \
  --env "REGISTRY_PROXY_REMOTEURL=http://fixture:$cold_port" \
  --env REGISTRY_PROXY_TTL=168h \
  --env REGISTRY_STORAGE_DELETE_ENABLED=true \
  --env REGISTRY_LOG_LEVEL=info \
  --env OTEL_TRACES_EXPORTER=none \
  "$registry_image" >/dev/null
docker network connect --alias registry-cache "$network" "$cache"
replacement_cache_address="$(docker inspect --format "{{with index .NetworkSettings.Networks \"$network\"}}{{.IPAddress}}{{end}}" "$cache")"
[[ "$replacement_cache_address" != "$previous_cache_address" ]] || {
  echo "replacement registry cache retained stale address $replacement_cache_address" >&2
  exit 1
}
docker rm --force "$address_reservation" >/dev/null
for _attempt in {1..100}; do
  docker exec "$client" wget -qO- http://registry-cache:5000/v2/ >/dev/null 2>&1 && break
  sleep 0.1
done
docker exec "$client" wget -qO- http://registry-cache:5000/v2/ >/dev/null 2>&1 || {
  echo "replacement registry cache readiness timed out" >&2
  exit 1
}
docker exec "$client" docker image rm "$cold_ref" >/dev/null
docker exec "$client" docker pull "$cold_ref" >"$root/replacement-pull.log" 2>&1
docker logs "$cache" >"$root/cache-after-replacement.log" 2>&1
replacement_ingress_count="$(dim_registry_cache_ingress_count "$root/cache-after-replacement.log" "$cold_repository")"
replacement_manifest_count="$(dim_registry_evidence_result_count "$cold_evidence" "$cold_repository" manifest)"
replacement_blob_count="$(dim_registry_evidence_result_count "$cold_evidence" "$cold_repository" blob)"
[[ "$replacement_ingress_count" -gt 0 ]] || {
  echo "replacement pull produced no route-local cache ingress" >&2
  exit 1
}
[[ "$replacement_manifest_count" -eq "$warm_manifest_count" && "$replacement_blob_count" -eq "$warm_blob_count" ]] || {
  echo "replacement pull unexpectedly fetched an upstream artifact" >&2
  exit 1
}

docker exec "$client" docker image rm "$cold_ref" >/dev/null
docker stop "$cache" >/dev/null
set +e
docker exec "$client" docker pull "$outage_ref" >"$root/outage-pull.log" 2>&1
outage_status=$?
set -e
[[ "$outage_status" -ne 0 ]] || { echo "outage pull unexpectedly succeeded" >&2; exit 1; }
dim_registry_assert_loopback_fallback "$root/outage-pull.log"
outage_request_count="$(dim_registry_request_count "$outage_evidence")"
[[ "$outage_request_count" -eq 0 ]] || {
  echo "outage pull bypassed the unavailable cache" >&2
  exit 1
}

printf 'cache-routing-summary cold_manifest=%s cold_config=%s cold_ingress=%s warm_ingress_delta=%s replacement_address=%s replacement_ingress=%s outage_status=%s outage_upstream_requests=%s\n' \
  "$cold_manifest_count" "$cold_blob_count" "$cold_ingress_count" \
  "$((warm_ingress_count - cold_ingress_count))" "$replacement_cache_address" "$replacement_ingress_count" \
  "$outage_status" "$outage_request_count"
echo "upstream-request-evidence:"
node -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$cold_evidence"
echo "cache-request-evidence:"
dim_registry_cache_request_evidence "$root/cache-after-warm.log" "$cold_repository"
echo "registry-cache-routing-smoke-ok"
