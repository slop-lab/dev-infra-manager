#!/usr/bin/env bash
set -uo pipefail

usage() {
  printf 'usage: %s WORKSPACE_IMAGE PROBE_IMAGE@sha256:DIGEST\n' "$0" >&2
}

if [[ "$#" -ne 2 ]]; then
  usage
  exit 2
fi

workspace_image="$1"
probe_image="$2"
startup_seconds=90
operation_seconds=30
diagnostic_kind=native-workspace-nested-docker-diagnostic

if [[ ! "$workspace_image" =~ ^[^[:space:]@]+(:[^/:[:space:]]+|@sha256:[0-9a-f]{64})$ ]] \
  || [[ "$workspace_image" == *:latest ]]; then
  printf 'workspace image must be an explicit non-latest tag or sha256 digest: %s\n' "$workspace_image" >&2
  exit 2
fi
if [[ ! "$probe_image" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]]; then
  printf 'probe image must be pinned as name@sha256:<64 lowercase hex>: %s\n' "$probe_image" >&2
  exit 2
fi
for command_name in docker timeout od grep stat mktemp tr; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'required command unavailable: %s\n' "$command_name" >&2
    exit 2
  }
done

random_hex="$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
if [[ ! "$random_hex" =~ ^[0-9a-f]{16}$ ]]; then
  printf 'unable to generate diagnostic resource scope\n' >&2
  exit 2
fi
scope="dim-nested-${BASHPID}-${random_hex}"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/dim-nested-diagnostic.XXXXXX")"
image_archive="$work_dir/probe-image.tar"
stage_output="$work_dir/stage-output"
cleanup_work_dir() { rm -rf -- "$work_dir"; }
trap cleanup_work_dir EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_stage() {
  local stage="$1"
  shift
  : >"$stage_output"
  timeout --kill-after=5s "${operation_seconds}s" "$@" >"$stage_output" 2>&1
  STAGE_STATUS=$?
  STAGE_NAME="$stage"
}

emit_stage_failure() {
  local lane="$1"
  printf 'lane=%s error_stage=%s error_begin\n' "$lane" "$STAGE_NAME"
  if [[ -s "$stage_output" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do printf '  %s\n' "$line"; done <"$stage_output"
  else
    printf '  command exited %s without output\n' "$STAGE_STATUS"
  fi
  printf 'lane=%s error_stage=%s error_end\n' "$lane" "$STAGE_NAME"
}

docker_field() {
  local format="$1"
  timeout --kill-after=5s "${operation_seconds}s" docker info --format "$format" 2>/dev/null || printf unavailable
}

printf 'diagnostic=%s scope=%s\n' "$diagnostic_kind" "$scope"
run_stage host-daemon docker info --format '{{.ServerVersion}}'
if [[ "$STAGE_STATUS" -ne 0 ]]; then
  emit_stage_failure host
  printf 'lane=runc status=UNAVAILABLE reason=host-docker-unreachable\n'
  printf 'lane=sysbox status=UNAVAILABLE reason=host-docker-unreachable\n'
  printf 'aggregate=FAIL failed_lanes=runc,sysbox\n'
  exit 1
fi

host_driver="$(docker_field '{{.Driver}}')"
host_backing="$(docker_field '{{range .DriverStatus}}{{if eq (index . 0) "Backing Filesystem"}}{{index . 1}}{{end}}{{end}}')"
host_image_store="$(docker_field '{{range .DriverStatus}}{{if eq (index . 0) "driver-type"}}{{index . 1}}{{end}}{{end}}')"
host_docker_root="$(docker_field '{{.DockerRootDir}}')"
[[ -n "$host_backing" ]] || host_backing="$(stat -f -c %T "$host_docker_root" 2>/dev/null || printf unreported)"
[[ -n "$host_image_store" ]] || host_image_store=classic
printf 'host storage_driver=%s backing_filesystem=%s image_store=%s cgroup_driver=%s cgroup_version=%s uid=%s docker_root_dir=%s\n' \
  "$host_driver" "$host_backing" "$host_image_store" \
  "$(docker_field '{{.CgroupDriver}}')" "$(docker_field '{{.CgroupVersion}}')" "$(id -u)" \
  "$host_docker_root"

workspace_id="$(timeout --kill-after=5s "${operation_seconds}s" docker image inspect "$workspace_image" --format '{{.Id}}' 2>/dev/null || true)"
if [[ ! "$workspace_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  printf 'lane=runc status=IMAGE_UNAVAILABLE reason=workspace-image-missing image=%s\n' "$workspace_image"
  printf 'lane=sysbox status=IMAGE_UNAVAILABLE reason=workspace-image-missing image=%s\n' "$workspace_image"
  printf 'aggregate=FAIL failed_lanes=runc,sysbox\n'
  exit 1
fi

probe_metadata="$(timeout --kill-after=5s "${operation_seconds}s" docker image inspect "$probe_image" \
  --format '{{.Id}}|{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null || true)"
probe_id="${probe_metadata%%|*}"
probe_digests="${probe_metadata#*|}"
if [[ ! "$probe_id" =~ ^sha256:[0-9a-f]{64}$ ]] || ! grep -Fxq "$probe_image" <<<"$probe_digests"; then
  printf 'lane=runc status=IMAGE_UNAVAILABLE reason=image-missing/network-required image=%s\n' "$probe_image"
  printf 'lane=sysbox status=IMAGE_UNAVAILABLE reason=image-missing/network-required image=%s\n' "$probe_image"
  printf 'aggregate=FAIL failed_lanes=runc,sysbox\n'
  exit 1
fi
run_stage cache-image-archive docker image save --output "$image_archive" "$probe_image"
if [[ "$STAGE_STATUS" -ne 0 ]]; then
  emit_stage_failure host
  printf 'lane=runc status=IMAGE_UNAVAILABLE reason=cached-image-export-failed\n'
  printf 'lane=sysbox status=IMAGE_UNAVAILABLE reason=cached-image-export-failed\n'
  printf 'aggregate=FAIL failed_lanes=runc,sysbox\n'
  exit 1
fi
printf 'images workspace_ref=%s workspace_id=%s probe_ref=%s probe_id=%s source=host-cache network_used=false\n' \
  "$workspace_image" "$workspace_id" "$probe_image" "$probe_id"

runtimes="$(docker_field '{{json .Runtimes}}')"
sysbox_available=false
[[ "$runtimes" == *'"sysbox-runc"'* ]] && sysbox_available=true

owned_container_identity() {
  local name="$1" expected_id="${2:-}" inspect_status
  bounded_inspect container "$name" \
    '{{.Id}}|{{.Name}}|{{index .Config.Labels "org.dim.verification"}}|{{index .Config.Labels "org.dim.verification.scope"}}'
  inspect_status=$?
  [[ "$inspect_status" -eq 0 ]] || return "$inspect_status"
  IFS='|' read -r OWNED_ID OWNED_NAME OWNED_KIND OWNED_SCOPE <<<"$INSPECT_OUTPUT"
  [[ "$OWNED_ID" =~ ^[0-9a-f]{64}$ && "$OWNED_NAME" == "/$name" \
    && "$OWNED_KIND" == "$diagnostic_kind" && "$OWNED_SCOPE" == "$scope" ]] || return 2
  [[ -z "$expected_id" || "$OWNED_ID" == "$expected_id" ]] || return 2
}

owned_volume() {
  local name="$1" inspect_status
  bounded_inspect volume "$name" \
    '{{.Name}}|{{.Driver}}|{{index .Labels "org.dim.verification"}}|{{index .Labels "org.dim.verification.scope"}}'
  inspect_status=$?
  [[ "$inspect_status" -eq 0 ]] || return "$inspect_status"
  [[ "$INSPECT_OUTPUT" == "$name|local|$diagnostic_kind|$scope" ]] || return 2
}

bounded_inspect() {
  local resource="$1" name="$2" format="$3" status output_file error_file error_output
  output_file="$work_dir/inspect-${BASHPID}.out"
  error_file="$work_dir/inspect-${BASHPID}.err"
  : >"$output_file"
  : >"$error_file"
  timeout --kill-after=5s "${operation_seconds}s" docker "$resource" inspect "$name" --format "$format" \
    >"$output_file" 2>"$error_file"
  status=$?
  INSPECT_OUTPUT="$(<"$output_file")"
  error_output="$(<"$error_file")"
  INSPECT_ERROR="$error_output"
  if [[ "$status" -eq 0 ]]; then
    return 0
  fi
  if [[ "$status" -eq 1 && -z "$INSPECT_OUTPUT" ]] \
    && [[ "$error_output" == "Error: No such $resource: $name" \
      || "$error_output" == "Error: No such object: $name" \
      || "$resource|$error_output" == "container|Error response from daemon: No such container: $name" \
      || "$resource|$error_output" == "volume|Error response from daemon: get $name: no such volume" ]]; then
    return 1
  fi
  return 3
}

cleanup_lane() {
  local lane="$1" container="$2"
  shift 2
  local cleanup_status=0 ownership_status volume
  owned_container_identity "$container"
  ownership_status=$?
  if [[ "$ownership_status" -eq 0 ]]; then
    timeout --kill-after=5s "${operation_seconds}s" docker container rm --force "$OWNED_ID" >/dev/null 2>&1 || cleanup_status=1
  elif [[ "$ownership_status" -eq 2 ]]; then
    printf 'lane=%s cleanup=REFUSED resource=container name=%s reason=foreign-or-unverifiable\n' "$lane" "$container" >&2
    cleanup_status=1
  elif [[ "$ownership_status" -eq 3 ]]; then
    printf 'lane=%s cleanup=FAILED resource=container name=%s reason=inspect-failed\n' "$lane" "$container" >&2
    printf '  %s\n' "${INSPECT_ERROR:-inspect failed without output}" >&2
    cleanup_status=1
  fi
  for volume in "$@"; do
    owned_volume "$volume"
    ownership_status=$?
    if [[ "$ownership_status" -eq 0 ]]; then
      timeout --kill-after=5s "${operation_seconds}s" docker volume rm "$volume" >/dev/null 2>&1 || cleanup_status=1
    elif [[ "$ownership_status" -eq 2 ]]; then
      printf 'lane=%s cleanup=REFUSED resource=volume name=%s reason=foreign-or-unverifiable\n' "$lane" "$volume" >&2
      cleanup_status=1
    elif [[ "$ownership_status" -eq 3 ]]; then
      printf 'lane=%s cleanup=FAILED resource=volume name=%s reason=inspect-failed\n' "$lane" "$volume" >&2
      printf '  %s\n' "${INSPECT_ERROR:-inspect failed without output}" >&2
      cleanup_status=1
    fi
  done
  return "$cleanup_status"
}

lane_fail() {
  local lane="$1" status="$2" reason="$3"
  emit_stage_failure "$lane"
  printf 'lane=%s status=%s reason=%s\n' "$lane" "$status" "$reason"
}

run_lane() (
  local lane="$1" runtime="$2" privileged="$3" data_target="$4"
  local prefix="dim-nested-${lane}-${BASHPID}-${random_hex}"
  local container="$prefix-outer" home="$prefix-home" checkout="$prefix-checkout" data="$prefix-data"
  local container_id="" volume deadline ready=false lane_pass=false inspect_status
  local -a volumes=("$home" "$checkout" "$data") create_arguments
  lane_exit() {
    local lane_status="$1" cleanup_status=0
    trap - EXIT INT TERM
    cleanup_lane "$lane" "$container" "${volumes[@]}" || cleanup_status=$?
    if [[ "$cleanup_status" -ne 0 ]]; then
      printf 'lane=%s status=FAIL reason=cleanup-incomplete\n' "$lane"
      exit 1
    fi
    if [[ "$lane_status" -eq 0 && "$lane_pass" == true ]]; then
      printf 'lane=%s status=PASS\n' "$lane"
    fi
    exit "$lane_status"
  }
  trap 'lane_exit "$?"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  printf 'lane=%s begin runtime=%s privileged=%s data_root_mount=%s\n' "$lane" "$runtime" "$privileged" "$data_target"
  if [[ "$lane" == sysbox && "$sysbox_available" != true ]]; then
    printf 'lane=sysbox status=UNAVAILABLE reason=sysbox-runc-not-registered\n'
    return 1
  fi

  for volume in "${volumes[@]}"; do
    run_stage volume-create docker volume create \
      --label "org.dim.verification=$diagnostic_kind" --label "org.dim.verification.scope=$scope" "$volume"
    if [[ "$STAGE_STATUS" -ne 0 ]] || ! owned_volume "$volume"; then
      [[ "$STAGE_STATUS" -ne 0 ]] || { STAGE_NAME=volume-ownership; STAGE_STATUS=1; printf 'created volume ownership did not match\n' >"$stage_output"; }
      lane_fail "$lane" FAIL volume-create-or-ownership
      return 1
    fi
  done

  create_arguments=(container create --name "$container" --runtime "$runtime"
    --label "org.dim.verification=$diagnostic_kind" --label "org.dim.verification.scope=$scope"
    --mount "type=volume,source=$home,target=/home/dim"
    --mount "type=volume,source=$checkout,target=/workspace"
    --mount "type=volume,source=$data,target=$data_target")
  if [[ "$privileged" == true ]]; then
    create_arguments+=(--privileged --env "DIM_DOCKERD_FLAGS=--feature containerd-snapshotter=false" "$workspace_image" sleep infinity)
  else
    create_arguments+=(--entrypoint /usr/local/bin/dim-agent-entrypoint "$workspace_image" sleep infinity)
  fi
  run_stage outer-create docker "${create_arguments[@]}"
  container_id="$(tr -d '\r\n' <"$stage_output")"
  if [[ "$STAGE_STATUS" -ne 0 || ! "$container_id" =~ ^[0-9a-f]{64}$ ]] \
    || ! owned_container_identity "$container" "$container_id"; then
    [[ "$STAGE_STATUS" -ne 0 ]] || { STAGE_NAME=outer-ownership; STAGE_STATUS=1; printf 'created container ownership did not match\n' >"$stage_output"; }
    lane_fail "$lane" FAIL outer-create-or-ownership
    return 1
  fi
  run_stage outer-start docker container start "$container_id"
  if [[ "$STAGE_STATUS" -ne 0 ]]; then
    lane_fail "$lane" FAIL outer-start
    return 1
  fi
  owned_container_identity "$container" "$container_id" || {
    STAGE_NAME=runtime-ownership; STAGE_STATUS=1; printf 'container ownership changed before runtime inspection\n' >"$stage_output"
    lane_fail "$lane" FAIL foreign-container
    return 1
  }
  bounded_inspect container "$container_id" '{{.HostConfig.Runtime}}|{{.HostConfig.Privileged}}'
  inspect_status=$?
  runtime_readback="$INSPECT_OUTPUT"
  if [[ "$inspect_status" -ne 0 || "$runtime_readback" != "$runtime|$privileged" ]]; then
    STAGE_NAME=runtime-readback; STAGE_STATUS=1
    printf 'outer runtime readback mismatch: expected %s|%s, observed %s\n' "$runtime" "$privileged" "${runtime_readback:-missing}" >"$stage_output"
    lane_fail "$lane" FAIL runtime-readback
    return 1
  fi

  deadline=$((SECONDS + startup_seconds))
  while (( SECONDS < deadline )); do
    if owned_container_identity "$container" "$container_id" \
      && timeout --kill-after=2s 5s docker exec --user dim "$container_id" docker info >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then
    run_stage nested-daemon-readiness docker exec --user dim "$container_id" docker info
    lane_fail "$lane" FAIL nested-daemon-not-ready
    return 1
  fi

  owned_container_identity "$container" "$container_id" || {
    STAGE_NAME=pre-inspect-ownership; STAGE_STATUS=1; printf 'container ownership changed before inspection\n' >"$stage_output"
    lane_fail "$lane" FAIL foreign-container
    return 1
  }
  bounded_inspect container "$container_id" "{{range .Mounts}}{{if eq .Destination \"$data_target\"}}{{.Type}}|{{.Name}}|{{.Destination}}|{{.RW}}{{end}}{{end}}"
  inspect_status=$?
  outer_mount="$INSPECT_OUTPUT"
  if [[ "$inspect_status" -ne 0 ]]; then
    STAGE_NAME=outer-mount-inspect; STAGE_STATUS="$inspect_status"; printf '%s\n' "${INSPECT_ERROR:-container inspect failed without output}" >"$stage_output"
    lane_fail "$lane" FAIL outer-mount-inspect
    return 1
  fi
  outer_uid="$(timeout --kill-after=5s "${operation_seconds}s" docker exec --user dim "$container_id" id -u 2>/dev/null || printf unavailable)"
  outer_data_fs="$(timeout --kill-after=5s "${operation_seconds}s" docker exec --user dim "$container_id" stat -f -c %T "$data_target" 2>/dev/null || printf unavailable)"
  inner_driver="$(timeout --kill-after=5s "${operation_seconds}s" docker exec --user dim "$container_id" docker info --format '{{.Driver}}' 2>/dev/null || printf unavailable)"
  inner_backing="$(timeout --kill-after=5s "${operation_seconds}s" docker exec --user dim "$container_id" docker info --format '{{range .DriverStatus}}{{if eq (index . 0) "Backing Filesystem"}}{{index . 1}}{{end}}{{end}}' 2>/dev/null || printf unavailable)"
  inner_image_store="$(timeout --kill-after=5s "${operation_seconds}s" docker exec --user dim "$container_id" docker info --format '{{range .DriverStatus}}{{if eq (index . 0) "driver-type"}}{{index . 1}}{{end}}{{end}}' 2>/dev/null || printf unavailable)"
  [[ -n "$inner_backing" ]] || inner_backing="$outer_data_fs"
  [[ -n "$inner_image_store" ]] || inner_image_store=classic
  printf 'lane=%s outer_uid=%s mount=%s mount_filesystem=%s inner_storage_driver=%s inner_backing_filesystem=%s inner_image_store=%s inner_cgroup_driver=%s inner_cgroup_version=%s inner_docker_root_dir=%s\n' \
    "$lane" "$outer_uid" "$outer_mount" "$outer_data_fs" "$inner_driver" "$inner_backing" "$inner_image_store" \
    "$(timeout --kill-after=5s "${operation_seconds}s" docker exec --user dim "$container_id" docker info --format '{{.CgroupDriver}}' 2>/dev/null || printf unavailable)" \
    "$(timeout --kill-after=5s "${operation_seconds}s" docker exec --user dim "$container_id" docker info --format '{{.CgroupVersion}}' 2>/dev/null || printf unavailable)" \
    "$(timeout --kill-after=5s "${operation_seconds}s" docker exec --user dim "$container_id" docker info --format '{{.DockerRootDir}}' 2>/dev/null || printf unavailable)"

  owned_container_identity "$container" "$container_id" || {
    STAGE_NAME=pre-load-ownership; STAGE_STATUS=1; printf 'container ownership unavailable before nested image load\n' >"$stage_output"
    lane_fail "$lane" FAIL pre-load-ownership
    return 1
  }
  : >"$stage_output"
  timeout --kill-after=5s "${operation_seconds}s" docker exec --user dim -i "$container_id" docker image load \
    <"$image_archive" >"$stage_output" 2>&1
  STAGE_STATUS=$?; STAGE_NAME=nested-image-load
  if [[ "$STAGE_STATUS" -ne 0 ]]; then
    lane_fail "$lane" FAIL nested-image-load
    return 1
  fi
  loaded_id="$(timeout --kill-after=5s "${operation_seconds}s" docker exec --user dim "$container_id" docker image inspect "$probe_id" --format '{{.Id}}' 2>/dev/null || true)"
  if [[ "$loaded_id" != "$probe_id" ]]; then
    STAGE_NAME=nested-image-verify; STAGE_STATUS=1
    printf 'loaded image ID mismatch: expected %s, observed %s\n' "$probe_id" "${loaded_id:-missing}" >"$stage_output"
    lane_fail "$lane" FAIL nested-image-verify
    return 1
  fi

  run_stage nested-image-run docker exec --user dim "$container_id" docker run --rm --network none \
    --entrypoint /bin/sh "$probe_id" -c 'id -u; printf "nested-image-execution-ok\n"'
  run_output="$(<"$stage_output")"
  if [[ "$STAGE_STATUS" -ne 0 || "$run_output" != $'0\nnested-image-execution-ok' ]]; then
    [[ "$STAGE_STATUS" -ne 0 ]] || STAGE_STATUS=1
    lane_fail "$lane" FAIL nested-image-run
    return 1
  fi
  printf 'lane=%s nested_image_id=%s nested_uid=0 execution=nested-image-execution-ok\n' "$lane" "$loaded_id"
  lane_pass=true
)

failed_lanes=()
run_lane runc runc true /var/lib/dim/workspace-data || failed_lanes+=(runc)
run_lane sysbox sysbox-runc false /var/lib/docker || failed_lanes+=(sysbox)

if [[ "${#failed_lanes[@]}" -ne 0 ]]; then
  joined="$(IFS=,; printf '%s' "${failed_lanes[*]}")"
  printf 'aggregate=FAIL failed_lanes=%s\n' "$joined"
  exit 1
fi
printf 'aggregate=PASS failed_lanes=none\n'
