#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
node_major="${DIM_SOURCE_NODE_MAJOR:-24}"
case "$node_major" in
  24|26) ;;
  *) printf 'DIM_SOURCE_NODE_MAJOR must be 24 or 26, received: %s\n' "$node_major" >&2; exit 2 ;;
esac
container="dim-source-gate-$(printf '%s' "$$-$(date +%s%N)" | sha256sum | cut -c1-12)"
verification_id="$container"
source "$repository_root/verification/scripts/lib/check-output.bash"
check_output_init "${DIM_CHECK_LOG_DIR:-$repository_root/.local/checks}"
collect_logs=0

command -v docker >/dev/null 2>&1 || {
  printf 'Docker is required for the isolated source gate.\n' >&2
  exit 1
}
iid_file="$(mktemp)"

remove_owned_container() {
  local inspected id owner resource extra removed
  inspected="$(docker container inspect --format \
    '{{.Id}}|{{index .Config.Labels "org.dim.verification"}}|{{index .Config.Labels "org.dim.resource"}}' \
    "$container" 2>&1)" || {
      while [[ "$inspected" == $'\n'* ]]; do inspected="${inspected#$'\n'}"; done
      case "$inspected" in
        "Error: No such container: $container"|"Error: No such object: $container"|\
        "Error response from daemon: No such container: $container"|"Error response from daemon: No such object: $container") return 0 ;;
        *) printf 'failed to inspect source-gate container %s: %s\n' "$container" "$inspected" >&2; return 1 ;;
      esac
    }
  IFS='|' read -r id owner resource extra <<<"$inspected"
  if [[ ! "$id" =~ ^[0-9a-f]{64}$ || -n "$extra" || "$owner" != "$verification_id" || "$resource" != source-gate ]]; then
    printf 'preserving source-gate container with foreign or malformed ownership: %s\n' "$container" >&2
    return 1
  fi
  local evidence_status=0
  if (( collect_logs )) && ! docker container cp "$id:/tmp/dim-source-checks" "$CHECK_OUTPUT_ROOT/container" >"$CHECK_OUTPUT_ROOT/log-export.log" 2>&1; then
    printf '[check] could not export container logs: %s/log-export.log\n' "$CHECK_OUTPUT_ROOT" >&2
    evidence_status=1
  elif (( collect_logs )); then
    printf '[check] container logs: %s/container\n' "$CHECK_OUTPUT_ROOT"
  fi
  removed="$(docker container rm --force "$id" 2>&1)" || {
    printf 'failed to remove owned source-gate container %s: %s\n' "$id" "$removed" >&2
    return 1
  }
  [[ "$removed" == "$id" ]] || {
    printf 'owned source-gate container removal returned unexpected identity: %s\n' "$removed" >&2
    return 1
  }
  return "$evidence_status"
}

cleanup() {
  local status=$?
  trap - EXIT
  check_output_stop
  rm -f -- "$iid_file"
  if ! remove_owned_container; then
    (( status != 0 )) || status=1
  fi
  exit "$status"
}
trap cleanup EXIT

check_output_run image-build docker build --target "source-node-$node_major" --iidfile "$iid_file" "$repository_root/verification/source-gate"
image_id="$(tr -d '\r\n' <"$iid_file")"
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  printf 'source-gate build returned malformed image ID: %s\n' "$image_id" >&2
  exit 1
}
printf 'source-gate Node.js lane: %s; image ID: %s; CPU limit: 2\n' "$node_major" "$image_id"
check_output_run container-start docker run --detach --init --cpus 2 --name "$container" \
  --label "org.dim.verification=$verification_id" \
  --label "org.dim.resource=source-gate" \
  --security-opt no-new-privileges \
  "$image_id"
printf '[check] container: %s\n' "$container"

check_output_run source-copy bash -o pipefail -c 'bash "$1" "$2" | docker container cp - "$3:/workspace"' \
  _ "$repository_root/verification/source-gate/archive.bash" "$repository_root" "$container"
check_output_run source-initialize docker exec "$container" bash -e -c '
  chmod --recursive a+rX /workspace
  git init --quiet /workspace
  git config --global user.name dim-source-gate
  git config --global user.email source-gate@invalid
  git -C /workspace add --all
  git -C /workspace commit --quiet --message source-gate-snapshot
'
check_output_run dependencies docker exec "$container" pnpm install --frozen-lockfile

if (( $# == 0 )); then
  collect_logs=1
  docker exec --env "DIM_SOURCE_NODE_MAJOR=$node_major" --env "DIM_CHECK_VERBOSE=${DIM_CHECK_VERBOSE:-0}" "$container" /usr/local/bin/dim-source-gate-run
else
  check_output_run command docker exec --env "DIM_SOURCE_NODE_MAJOR=$node_major" --env "DIM_CHECK_VERBOSE=${DIM_CHECK_VERBOSE:-0}" "$container" /usr/local/bin/dim-source-gate-run "$@"
fi
