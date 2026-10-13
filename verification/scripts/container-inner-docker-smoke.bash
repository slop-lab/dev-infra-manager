#!/usr/bin/env bash
set -euo pipefail

inner_image="${DIM_CONTAINER_TEST_IMAGE:-alpine:3.22}"
dockerd_flags="--feature containerd-snapshotter=false"
expected_driver="overlay2"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
cd "$repo_root"
local_version="$(bash "$script_dir/local-build-version.bash")"
workspace_image="dev-infra-project-workspace:$local_version"
dim_uid="$(docker run --rm --entrypoint id "$workspace_image" -u dim)"
dim_gid="$(docker run --rm --entrypoint id "$workspace_image" -g dim)"
work_dir="$(mktemp -d /tmp/dim-root-replacement.XXXXXX)"
verification_id="container-inner-docker-smoke-$(id -u)-$$-$RANDOM"
outer_smoke_name="dim-inner-smoke-$verification_id"
outer_name="dim-root-replacement-$verification_id"
data_volume="dim-root-replacement-data-$verification_id"
incompatible_volume="dim-root-replacement-incompatible-$verification_id"
resource_labels=(
  --label "org.dim.verification=$verification_id"
  --label "org.dim.resource=container-inner-docker-smoke"
)

remove_owned_container() {
  local name="$1"
  local inspected id owner resource extra removed
  inspected="$(docker container inspect --format \
    '{{.Id}}|{{index .Config.Labels "org.dim.verification"}}|{{index .Config.Labels "org.dim.resource"}}' \
    "$name" 2>&1)" || {
      while [[ "$inspected" == $'\n'* ]]; do inspected="${inspected#$'\n'}"; done
      case "$inspected" in
        "Error: No such container: $name"|"Error: No such object: $name"|\
        "Error response from daemon: No such container: $name"|"Error response from daemon: No such object: $name") return 0 ;;
        *) printf 'failed to inspect cleanup container %s: %s\n' "$name" "$inspected" >&2; return 1 ;;
      esac
    }
  IFS='|' read -r id owner resource extra <<<"$inspected"
  if [[ ! "$id" =~ ^[0-9a-f]{64}$ || -z "$owner" || -z "$resource" || -n "$extra" ]]; then
    printf 'refusing malformed cleanup container snapshot: %s\n' "$name" >&2
    return 1
  fi
  if [[ "$owner" != "$verification_id" || "$resource" != container-inner-docker-smoke ]]; then
    printf 'preserving container with foreign ownership: %s\n' "$name" >&2
    return 1
  fi
  removed="$(docker container rm --force "$id" 2>&1)" || {
    printf 'failed to remove owned container %s: %s\n' "$id" "$removed" >&2
    return 1
  }
  [[ "$removed" == "$id" ]] || {
    printf 'owned container removal returned unexpected identity: %s\n' "$name" >&2
    return 1
  }
}

remove_owned_volume() {
  local name="$1"
  local inspected actual owner resource extra removed
  inspected="$(docker volume inspect --format \
    '{{.Name}}|{{index .Labels "org.dim.verification"}}|{{index .Labels "org.dim.resource"}}' \
    "$name" 2>&1)" || {
      while [[ "$inspected" == $'\n'* ]]; do inspected="${inspected#$'\n'}"; done
      case "$inspected" in
        "Error: No such volume: $name"|"Error response from daemon: No such volume: $name"|\
        "Error response from daemon: get $name: no such volume") return 0 ;;
        *) printf 'failed to inspect cleanup volume %s: %s\n' "$name" "$inspected" >&2; return 1 ;;
      esac
    }
  IFS='|' read -r actual owner resource extra <<<"$inspected"
  if [[ "$actual" != "$name" || -z "$owner" || -z "$resource" || -n "$extra" ]]; then
    printf 'refusing malformed cleanup volume snapshot: %s\n' "$name" >&2
    return 1
  fi
  if [[ "$owner" != "$verification_id" || "$resource" != container-inner-docker-smoke ]]; then
    printf 'preserving volume with foreign ownership: %s\n' "$name" >&2
    return 1
  fi
  removed="$(docker volume rm "$name" 2>&1)" || {
    printf 'failed to remove owned volume %s: %s\n' "$name" "$removed" >&2
    return 1
  }
  [[ "$removed" == "$name" ]] || {
    printf 'owned volume removal returned unexpected identity: %s\n' "$name" >&2
    return 1
  }
}

cleanup_resources() {
  local failed=0
  remove_owned_container "$outer_smoke_name" || failed=1
  remove_owned_container "$outer_name" || failed=1
  remove_owned_container "$outer_name-incompatible" || failed=1
  remove_owned_volume "$data_volume" || failed=1
  remove_owned_volume "$incompatible_volume" || failed=1
  rm -rf -- "$work_dir" || failed=1
  return "$failed"
}

cleanup_on_exit() {
  local original_status=$?
  local cleanup_status
  trap - EXIT
  set +e
  cleanup_resources
  cleanup_status=$?
  if [[ "$original_status" -ne 0 ]]; then
    exit "$original_status"
  fi
  exit "$cleanup_status"
}
trap cleanup_on_exit EXIT

run_inner_smoke() {
  local outer_image="$1"
  shift

  docker run --name "$outer_smoke_name" --privileged --runtime runc \
    "${resource_labels[@]}" \
    --env "DIM_DOCKERD_FLAGS=$dockerd_flags" \
    --mount "type=volume,source=$data_volume,target=/var/lib/dim/workspace-data" \
    "$@" "$outer_image" bash -lc "
    driver=\"\$(docker info --format '{{.Driver}}')\"
    data_root=\"\$(docker info --format '{{.DockerRootDir}}')\"
    data_fstype=\"\$(stat -f -c %T /var/lib/dim/workspace-data)\"
    grep -F ' /var/lib/dim/workspace-data ' /proc/self/mountinfo >/dev/null
    printf 'inner-docker-runtime driver=%s data-root=%s data-fstype=%s\\n' \
      \"\$driver\" \"\$data_root\" \"\$data_fstype\"
    test \"\$driver\" = '$expected_driver'
    test \"\$data_root\" = /var/lib/dim/workspace-data/docker
    docker pull '$inner_image' >/dev/null
    docker image inspect '$inner_image' >/dev/null
    docker run --pull=never --rm '$inner_image' sh -c \
      'wget -qO- https://example.com >/dev/null && echo inner-docker-network-ok'
  "
  test "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/dim/workspace-data"}}{{.Name}}|{{.RW}}{{end}}{{end}}' "$outer_smoke_name")" \
    = "$data_volume|true"
  remove_owned_container "$outer_smoke_name"
}

mkdir -p "$work_dir/root-a" "$work_dir/root-b"
printf '%s\n' A >"$work_dir/root-a/sentinel"
printf '%s\n' B >"$work_dir/root-b/sentinel"
docker volume create "${resource_labels[@]}" "$data_volume" >/dev/null
docker run --rm "${resource_labels[@]}" --volume "$data_volume:/data" "$inner_image" sh -c \
  'chown "$1:$2" /data && mkdir /data/owned-descendant && chown 1234:2345 /data/owned-descendant && chmod 0751 /data/owned-descendant' \
  sh "$dim_uid" "$dim_gid"

run_inner_smoke "$workspace_image"

start_outer() {
  local root_snapshot="$1"
  docker run --detach --privileged --runtime runc \
    --name "$outer_name" \
    "${resource_labels[@]}" \
    --env "DIM_DOCKERD_FLAGS=$dockerd_flags" \
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
docker exec --user dim "$outer_name" docker image inspect "$inner_image" >/dev/null
test "$(docker exec --user dim "$outer_name" docker run --pull=never --rm "$inner_image" printf cached-inner-execution-ok)" \
  = cached-inner-execution-ok
remove_owned_container "$outer_name"

start_outer "$work_dir/root-a"
test "$(docker exec "$outer_name" cat /run/dim/project-root/sentinel)" = A
docker exec --user dim "$outer_name" docker image inspect "$inner_image" >/dev/null
test "$(docker run --rm "${resource_labels[@]}" --volume "$data_volume:/data" "$inner_image" stat -c '%u:%g:%a' /data/owned-descendant)" \
  = 1234:2345:751
remove_owned_container "$outer_name"

docker volume create "${resource_labels[@]}" "$incompatible_volume" >/dev/null
docker run --rm "${resource_labels[@]}" --volume "$incompatible_volume:/data" "$inner_image" sh -c 'touch /data/populated'
if docker run --name "$outer_name-incompatible" \
  "${resource_labels[@]}" \
  --volume "$incompatible_volume:/var/lib/dim/workspace-data" \
  "$workspace_image" true >/dev/null 2>&1; then
  echo "workspace entrypoint accepted populated incompatible data ownership" >&2
  exit 1
fi
docker logs "$outer_name-incompatible" 2>&1 | grep -Fq \
  "workspace data root is populated with incompatible ownership"

cleanup_resources
trap - EXIT
echo "container-inner-docker-smoke-ok"
