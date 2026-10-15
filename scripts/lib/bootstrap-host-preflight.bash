#!/usr/bin/env bash

preflight_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
pins_helper="${pins_helper:-$preflight_dir/bootstrap-ubuntu-pins.bash}"
source "$pins_helper"

dim_reject_docker_redirects() {
  local variable
  for variable in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION; do
    [[ ! -v "$variable" ]] || { echo "bootstrap requires the local default Docker endpoint; unset $variable" >&2; return 2; }
  done
}

dim_verify_local_docker_endpoint() {
  local context endpoint
  context="$(docker context show)" || return 1
  [[ "$context" == default ]] || { echo "Docker context must be default, found: $context" >&2; return 1; }
  endpoint="$(docker context inspect default --format '{{.Endpoints.docker.Host}}')" || return 1
  case "$endpoint" in unix:///var/run/docker.sock|unix:///run/docker.sock) ;; *) echo "Docker endpoint must be the local system socket, found: $endpoint" >&2; return 1 ;; esac
}

dim_verify_host_stack() {
  local package expected actual
  while IFS='|' read -r package expected; do
    actual="$(dpkg-query -W -f='${Version}' "$package" 2>/dev/null || true)"
    [[ "$actual" == "$expected" ]] || { echo "pinned host package mismatch: $package expected $expected, found ${actual:-absent}" >&2; return 1; }
  done <<EOF
docker-ce|$dim_docker_package_version
docker-ce-cli|$dim_docker_package_version
containerd.io|$dim_containerd_package_version
docker-buildx-plugin|$dim_buildx_package_version
docker-compose-plugin|$dim_compose_package_version
sysbox-ce|$dim_sysbox_package_version
EOF
  [[ "$(docker version --format '{{.Server.Version}}')" == "$dim_docker_engine_version" ]] || { echo "Docker daemon is not pinned $dim_docker_engine_version" >&2; return 1; }
  docker info --format '{{json .DriverStatus}}' | grep -Fq io.containerd.snapshotter.v1 || { echo "Docker containerd image store is not active" >&2; return 1; }
  docker info --format '{{json .Runtimes}}' | grep -Fq 'sysbox-runc' || { echo "Sysbox $dim_sysbox_version is not registered with Docker" >&2; return 1; }
  [[ "$(docker compose version --short)" == "$dim_compose_version" ]] || { echo "Docker Compose is not pinned $dim_compose_version" >&2; return 1; }
  [[ "$($dim_node_root/bin/node --version)" == "v$dim_node_version" ]] || { echo "Node.js is not pinned $dim_node_version" >&2; return 1; }
  [[ "$($dim_source_tools_root/bin/pnpm --version)" == "$dim_pnpm_version" ]] || { echo "pnpm is not pinned $dim_pnpm_version" >&2; return 1; }
  [[ "$($dim_source_tools_root/bin/just --version)" == "just $dim_just_version" ]] || { echo "Just is not pinned $dim_just_version" >&2; return 1; }
}
