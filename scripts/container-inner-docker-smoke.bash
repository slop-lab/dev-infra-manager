#!/usr/bin/env bash
set -euo pipefail

inner_image="${DIM_CONTAINER_TEST_IMAGE:-alpine:3.22}"
outer_driver="${DIM_OUTER_DOCKER_DRIVER:-overlayfs}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
cd "$repo_root"
local_version="$(bash "$script_dir/local-build-version.bash")"
workspace_image="dev-infra-project-workspace:$local_version"
dim_uid="$(docker run --rm --entrypoint id "$workspace_image" -u dim)"
dim_gid="$(docker run --rm --entrypoint id "$workspace_image" -g dim)"
work_dir="$(mktemp -d /tmp/dim-root-replacement.XXXXXX)"
outer_name="dim-root-replacement-$$"
data_volume="dim-root-replacement-data-$$"
incompatible_volume="dim-root-replacement-incompatible-$$"

cleanup() {
  docker container rm --force "$outer_name" >/dev/null 2>&1 || true
  docker container rm --force "$outer_name-incompatible" >/dev/null 2>&1 || true
  docker volume rm --force "$data_volume" "$incompatible_volume" >/dev/null 2>&1 || true
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

run_inner_smoke() {
  local outer_image="$1"
  local expected_driver="$2"
  shift 2

  docker run --rm --privileged --runtime runc "$@" "$outer_image" bash -lc "
    test \"\\\$(docker info --format '{{.Driver}}')\" = '$expected_driver'
    docker run --rm '$inner_image' sh -c \
      'wget -qO- https://example.com >/dev/null && echo inner-docker-network-ok'
  "
}

run_inner_smoke "$workspace_image" "$outer_driver" \
  --env "DIM_DOCKERD_FLAGS=--storage-driver=$outer_driver"

mkdir -p "$work_dir/root-a" "$work_dir/root-b"
printf '%s\n' A >"$work_dir/root-a/sentinel"
printf '%s\n' B >"$work_dir/root-b/sentinel"
docker volume create "$data_volume" >/dev/null
docker run --rm --volume "$data_volume:/data" "$inner_image" sh -c \
  'chown "$1:$2" /data && mkdir /data/owned-descendant && chown 1234:2345 /data/owned-descendant && chmod 0751 /data/owned-descendant' \
  sh "$dim_uid" "$dim_gid"

start_outer() {
  local root_snapshot="$1"
  docker run --detach --privileged --runtime runc \
    --name "$outer_name" \
    --env "DIM_DOCKERD_FLAGS=--storage-driver=$outer_driver" \
    --mount "type=volume,source=$data_volume,target=/var/lib/dim/workspace-data" \
    --mount "type=bind,source=$root_snapshot,target=/run/dim/project-root,readonly" \
    "$workspace_image" sleep infinity >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$outer_name" docker info >/dev/null 2>&1 && return
    sleep 1
  done
  docker logs "$outer_name" >&2
  return 1
}

start_outer "$work_dir/root-b"
test "$(docker exec "$outer_name" cat /run/dim/project-root/sentinel)" = B
test "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/run/dim/project-root"}}{{.Source}}|{{.RW}}{{end}}{{end}}' "$outer_name")" \
  = "$work_dir/root-b|false"
docker exec --user dim "$outer_name" docker pull "$inner_image" >/dev/null
docker container rm --force "$outer_name" >/dev/null

start_outer "$work_dir/root-a"
test "$(docker exec "$outer_name" cat /run/dim/project-root/sentinel)" = A
docker exec --user dim "$outer_name" docker image inspect "$inner_image" >/dev/null
test "$(docker run --rm --volume "$data_volume:/data" "$inner_image" stat -c '%u:%g:%a' /data/owned-descendant)" \
  = 1234:2345:751
docker container rm --force "$outer_name" >/dev/null

docker volume create "$incompatible_volume" >/dev/null
docker run --rm --volume "$incompatible_volume:/data" "$inner_image" sh -c 'touch /data/populated'
if docker run --name "$outer_name-incompatible" \
  --volume "$incompatible_volume:/var/lib/dim/workspace-data" \
  "$workspace_image" true >/dev/null 2>&1; then
  echo "workspace entrypoint accepted populated incompatible data ownership" >&2
  exit 1
fi
docker logs "$outer_name-incompatible" 2>&1 | grep -Fq \
  "workspace data root is populated with incompatible ownership"

echo "container-inner-docker-smoke-ok"
