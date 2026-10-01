#!/usr/bin/env bash

dim_cache_routing_enabled() {
  [[ -n "${DIM_CACHE_ROUTING_ROUTES_ROOT:-}" ]]
}

dim_cache_routing_select_route() {
  local route="$1" cold_ready outage_ready
  cold_ready="$DIM_CACHE_ROUTING_ROUTES_ROOT/$route-cold-ready.json"
  outage_ready="$DIM_CACHE_ROUTING_ROUTES_ROOT/$route-outage-ready.json"
  [[ -s "$cold_ready" && -s "$outage_ready" ]] || {
    echo "cache-routing fixture metadata is missing for route $route" >&2
    return 1
  }
  export DIM_CACHE_ROUTING_ROUTE="$route"
  export DIM_CACHE_ROUTING_REPOSITORY
  DIM_CACHE_ROUTING_REPOSITORY="$(dim_registry_fixture_field "$cold_ready" repository)"
  export DIM_CACHE_ROUTING_REF="docker.io/$DIM_CACHE_ROUTING_REPOSITORY@$(dim_registry_fixture_field "$cold_ready" manifest_digest)"
  export DIM_CACHE_ROUTING_UPSTREAM_EVIDENCE="$DIM_CACHE_ROUTING_ROUTES_ROOT/$route-cold-upstream.jsonl"
  export DIM_CACHE_ROUTING_FIXTURE_PORT
  DIM_CACHE_ROUTING_FIXTURE_PORT="$(dim_registry_fixture_field "$cold_ready" port)"
  export DIM_CACHE_ROUTING_OUTAGE_REPOSITORY
  DIM_CACHE_ROUTING_OUTAGE_REPOSITORY="$(dim_registry_fixture_field "$outage_ready" repository)"
  export DIM_CACHE_ROUTING_OUTAGE_REF="docker.io/$DIM_CACHE_ROUTING_OUTAGE_REPOSITORY@$(dim_registry_fixture_field "$outage_ready" manifest_digest)"
  export DIM_CACHE_ROUTING_OUTAGE_EVIDENCE="$DIM_CACHE_ROUTING_ROUTES_ROOT/$route-outage-upstream.jsonl"
}

dim_cache_routing_ingress_count() {
  local log_file="$DIM_CACHE_ROUTING_EVIDENCE_ROOT/cache-current.log"
  docker logs "$DIM_CACHE_ROUTING_CACHE" >"$log_file" 2>&1
  dim_registry_cache_ingress_count "$log_file" "$DIM_CACHE_ROUTING_REPOSITORY"
}

dim_cache_routing_upstream_count() {
  dim_registry_artifact_count "$DIM_CACHE_ROUTING_UPSTREAM_EVIDENCE" "$DIM_CACHE_ROUTING_REPOSITORY"
}

dim_cache_routing_assert_phase_deltas() {
  local route="$1" phase="$2" ingress_before="$3" ingress_after="$4"
  local upstream_before="$5" upstream_after="$6" expected_upstream ingress_delta
  case "$phase" in
    cold) expected_upstream=3 ;;
    warm) expected_upstream=0 ;;
    *) echo "unknown cache-routing phase: $phase" >&2; return 2 ;;
  esac
  ingress_delta="$((ingress_after - ingress_before))"
  [[ "$ingress_delta" -gt 0 ]] || {
    echo "$route $phase pull cache-ingress delta was $ingress_delta, expected a route-local request" >&2
    return 1
  }
  [[ "$((upstream_after - upstream_before))" -eq "$expected_upstream" ]] || {
    echo "$route $phase pull upstream delta was $((upstream_after - upstream_before)), expected $expected_upstream" >&2
    return 1
  }
}

dim_cache_routing_assert_pull_evidence() {
  local route="$1" phase="$2" ingress_before="$3" upstream_before="$4" ingress_after upstream_after
  ingress_after="$(dim_cache_routing_ingress_count)"
  upstream_after="$(dim_cache_routing_upstream_count)"
  dim_cache_routing_assert_phase_deltas \
    "$route" "$phase" "$ingress_before" "$ingress_after" "$upstream_before" "$upstream_after"
  printf 'route=%q phase=%q ingress_delta=%s upstream_delta=%s\n' \
    "$route" "$phase" "$((ingress_after - ingress_before))" "$((upstream_after - upstream_before))" \
    >>"$DIM_CACHE_ROUTING_INGRESS_EVIDENCE"
}

dim_cache_routing_assert_complete_route() {
  local route="$1" ingress_before="$2" upstream_before="$3" ingress_after upstream_after
  ingress_after="$(dim_cache_routing_ingress_count)"
  upstream_after="$(dim_cache_routing_upstream_count)"
  [[ "$((ingress_after - ingress_before))" -gt 1 ]] || {
    echo "$route cold-plus-warm cache-ingress delta did not prove both pulls" >&2
    return 1
  }
  [[ "$((upstream_after - upstream_before))" -eq 3 ]] || {
    echo "$route cold-plus-warm upstream delta was $((upstream_after - upstream_before)), expected 3" >&2
    return 1
  }
  printf 'route=%q phase=complete ingress_delta=%s upstream_delta=3\n' \
    "$route" "$((ingress_after - ingress_before))" \
    >>"$DIM_CACHE_ROUTING_INGRESS_EVIDENCE"
}

dim_cache_routing_assert_no_outage_upstream() {
  local count
  count="$(dim_registry_request_count "$DIM_CACHE_ROUTING_OUTAGE_EVIDENCE")"
  [[ "$count" -eq 0 ]] || {
    echo "$DIM_CACHE_ROUTING_ROUTE outage bypassed the unavailable cache" >&2
    return 1
  }
}

dim_cache_routing_refresh_cache_address() {
  local previous_address="$1" replacement_address
  replacement_address="$(docker inspect --format \
    "{{with index .NetworkSettings.Networks \"${DIM_CACHE_ROUTING_NETWORK}\"}}{{.IPAddress}}{{end}}" \
    "$DIM_CACHE_ROUTING_CACHE")"
  [[ "$replacement_address" != "$previous_address" ]] || {
    echo "replacement registry cache retained stale address $replacement_address" >&2
    return 1
  }
  export DIM_CI_REGISTRY_CACHE_UPSTREAM="$DIM_CACHE_ROUTING_CACHE:5000"
}

dim_cache_routing_replace_cache() {
  local remote="$1" previous_address reservation
  reservation="$DIM_CACHE_ROUTING_CACHE-address-reservation"
  previous_address="$(docker inspect --format \
    "{{with index .NetworkSettings.Networks \"${DIM_CACHE_ROUTING_NETWORK}\"}}{{.IPAddress}}{{end}}" \
    "$DIM_CACHE_ROUTING_CACHE")"
  docker rm --force "$DIM_CACHE_ROUTING_CACHE" >/dev/null
  docker run --detach --name "$reservation" --network "$DIM_CACHE_ROUTING_NETWORK" \
    --ip "$previous_address" --label dim.verification=cache-routing \
    --entrypoint sleep "$DIM_CACHE_ROUTING_IMAGE" infinity >/dev/null
  docker run --detach --name "$DIM_CACHE_ROUTING_CACHE" --restart unless-stopped \
    --network "$DIM_CACHE_ROUTING_NETWORK" --network-alias "$DIM_CACHE_ROUTING_CACHE" \
    --add-host "fixture:$DIM_CACHE_ROUTING_FIXTURE_ADDRESS" \
    --mount "type=volume,source=$DIM_CACHE_ROUTING_VOLUME,target=/var/lib/registry" \
    --label dim.managed=true --label dim.resource=registry-cache \
    --env "REGISTRY_PROXY_REMOTEURL=$remote" \
    --env REGISTRY_PROXY_TTL=168h --env REGISTRY_STORAGE_DELETE_ENABLED=true \
    --env REGISTRY_LOG_LEVEL=info --env OTEL_TRACES_EXPORTER=none \
    "$DIM_CACHE_ROUTING_IMAGE" >/dev/null
  for _attempt in {1..100}; do
    if docker exec "$DIM_CACHE_ROUTING_CACHE" wget -qO- http://127.0.0.1:5000/v2/ >/dev/null 2>&1; then
      dim_cache_routing_refresh_cache_address "$previous_address"
      docker rm --force "$reservation" >/dev/null
      return
    fi
    sleep 0.1
  done
  echo "replacement registry cache readiness timed out" >&2
  return 1
}

dim_cache_routing_activate_fixture_cache() {
  dim_cache_routing_replace_cache "http://fixture:$DIM_CACHE_ROUTING_FIXTURE_PORT"
}

dim_cache_routing_activate_production_cache() {
  dim_cache_routing_replace_cache https://registry-1.docker.io
}

dim_cache_routing_pull_pair() {
  local route="$1"
  shift
  local ingress_before upstream_before
  ingress_before="$(dim_cache_routing_ingress_count)"
  upstream_before="$(dim_cache_routing_upstream_count)"
  "$@" pull "$DIM_CACHE_ROUTING_REF" >/dev/null
  dim_cache_routing_assert_pull_evidence "$route" cold "$ingress_before" "$upstream_before"
  "$@" image rm "$DIM_CACHE_ROUTING_REF" >/dev/null
  ingress_before="$(dim_cache_routing_ingress_count)"
  upstream_before="$(dim_cache_routing_upstream_count)"
  "$@" pull "$DIM_CACHE_ROUTING_REF" >/dev/null
  dim_cache_routing_assert_pull_evidence "$route" warm "$ingress_before" "$upstream_before"
}

dim_cache_routing_workspace_routes() {
  local workspace="$1" compose_name="$2" agent_dind outage_evidence
  dim_cache_routing_enabled || return 0
  dim_cache_routing_select_route workspace
  dim_cache_routing_activate_fixture_cache
  dim_cache_routing_pull_pair workspace dim workspace exec "$workspace" -- docker

  agent_dind="$(dim workspace exec "$workspace" -- docker compose \
    --project-name "$compose_name" --file .dim/docker-compose.yml \
    --file .dim/ci-registry-mirror.override.yml ps --quiet agent-dind)"
  [[ -n "$agent_dind" ]] || { echo "Compose did not resolve agent-dind" >&2; return 1; }
  dim_cache_routing_select_route agent-dind
  dim_cache_routing_activate_fixture_cache
  dim_cache_routing_pull_pair agent-dind dim workspace exec "$workspace" -- docker exec "$agent_dind" docker

  dim workspace exec "$workspace" -- sh -eu -c '
    relay_pid="$(cat /tmp/dim-ci-registry-cache-relay.pid)"
    kill "$relay_pid"
    for attempt in $(seq 1 100); do
      kill -0 "$relay_pid" 2>/dev/null || exit 0
      sleep 0.05
    done
    echo "workspace registry-cache relay did not stop" >&2
    exit 1
  '
  dim workspace exec "$workspace" -- docker exec "$agent_dind" docker image rm "$DIM_CACHE_ROUTING_REF" >/dev/null
  outage_evidence="$DIM_CACHE_ROUTING_EVIDENCE_ROOT/agent-dind-outage.log"
  if dim workspace exec "$workspace" -- docker exec "$agent_dind" \
    docker pull "$DIM_CACHE_ROUTING_OUTAGE_REF" >"$outage_evidence" 2>&1; then
    echo "agent-dind outage pull unexpectedly succeeded" >&2
    return 1
  fi
  dim_registry_assert_loopback_fallback "$outage_evidence"
  dim_cache_routing_assert_no_outage_upstream
  dim_cache_routing_activate_production_cache
}

dim_cache_routing_workspace_outage() {
  local workspace="$1" outage_evidence
  dim_cache_routing_enabled || return 0
  dim_cache_routing_select_route workspace
  docker stop "$DIM_CACHE_ROUTING_CACHE" >/dev/null
  outage_evidence="$DIM_CACHE_ROUTING_EVIDENCE_ROOT/workspace-outage.log"
  if dim workspace exec "$workspace" -- docker pull "$DIM_CACHE_ROUTING_OUTAGE_REF" >"$outage_evidence" 2>&1; then
    echo "workspace cache-outage pull unexpectedly succeeded" >&2
    return 1
  fi
  dim_registry_assert_loopback_fallback "$outage_evidence"
  dim_cache_routing_assert_no_outage_upstream
}

dim_cache_routing_runner_ready() {
  local runner="$1"
  dim_cache_routing_enabled || return 0
  dim_cache_routing_select_route sysbox-runner
  dim_cache_routing_activate_fixture_cache
  dim_cache_routing_pull_pair sysbox-runner docker exec "$runner" docker
  dim_cache_routing_activate_production_cache
}

dim_cache_routing_runner_outage() {
  local runner="$1" outage_evidence
  dim_cache_routing_enabled || return 0
  dim_cache_routing_select_route sysbox-runner
  docker stop "$DIM_CACHE_ROUTING_CACHE" >/dev/null
  outage_evidence="$DIM_CACHE_ROUTING_EVIDENCE_ROOT/sysbox-runner-outage.log"
  if docker exec "$runner" docker pull "$DIM_CACHE_ROUTING_OUTAGE_REF" >"$outage_evidence" 2>&1; then
    echo "Sysbox runner outage pull unexpectedly succeeded" >&2
    return 1
  fi
  dim_registry_assert_loopback_fallback "$outage_evidence"
  dim_cache_routing_assert_no_outage_upstream
}
