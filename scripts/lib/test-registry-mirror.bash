#!/usr/bin/env bash

dim_apply_test_registry_mirror() {
  local project_root="$1" service="${2:-agent-dind}" mirror="${DIM_DOCKER_REGISTRY_MIRROR:-}" endpoint setup temporary mirror_host
  [[ -n "$mirror" ]] || return 0
  [[ "$mirror" =~ ^http://([A-Za-z0-9.-]+):([1-9][0-9]*)$ ]] || {
    echo "invalid DIM_DOCKER_REGISTRY_MIRROR: $mirror" >&2
    return 2
  }
  endpoint="${BASH_REMATCH[1]}:${BASH_REMATCH[2]}"
  mirror_host="${DIM_TEST_REGISTRY_MIRROR_ADDRESS:-host-gateway}"
  setup="$project_root/.dim/setup.sh"
  test -f "$setup"

  cat >"$project_root/.dim/ci-registry-mirror.override.yml" <<EOF
services:
  $service:
    command:
      - --registry-mirror=$mirror
      - --insecure-registry=$endpoint
    extra_hosts:
      - "${BASH_REMATCH[1]}:$mirror_host"
EOF
  if ! grep -Fq 'ci-registry-mirror.override.yml' "$setup"; then
    temporary="$setup.tmp"
    sed 's#--file \.dim/docker-compose\.yml#--file .dim/docker-compose.yml --file .dim/ci-registry-mirror.override.yml#g' \
      "$setup" >"$temporary"
    mv "$temporary" "$setup"
  fi
}
