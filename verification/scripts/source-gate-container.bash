#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
container="dim-source-gate-$(printf '%s' "$$-$(date +%s%N)" | sha256sum | cut -c1-12)"
verification_id="$container"

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
  removed="$(docker container rm --force "$id" 2>&1)" || {
    printf 'failed to remove owned source-gate container %s: %s\n' "$id" "$removed" >&2
    return 1
  }
  [[ "$removed" == "$id" ]] || {
    printf 'owned source-gate container removal returned unexpected identity: %s\n' "$removed" >&2
    return 1
  }
}

cleanup() {
  local status=$?
  trap - EXIT
  rm -f -- "$iid_file"
  if ! remove_owned_container; then
    (( status != 0 )) || status=1
  fi
  exit "$status"
}
trap cleanup EXIT

docker build --iidfile "$iid_file" "$repository_root/verification/source-gate"
image_id="$(tr -d '\r\n' <"$iid_file")"
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  printf 'source-gate build returned malformed image ID: %s\n' "$image_id" >&2
  exit 1
}
printf 'source-gate image ID: %s\n' "$image_id"
docker run --detach --init --name "$container" \
  --label "org.dim.verification=$verification_id" \
  --label "org.dim.resource=source-gate" \
  --security-opt no-new-privileges \
  "$image_id" >/dev/null

bash "$repository_root/verification/source-gate/archive.bash" "$repository_root" \
  | docker container cp - "$container:/workspace"

docker exec "$container" chmod --recursive a+rX /workspace
docker exec "$container" git init --quiet /workspace
docker exec "$container" git config --global user.name dim-source-gate
docker exec "$container" git config --global user.email source-gate@invalid
docker exec "$container" git -C /workspace add --all
docker exec "$container" git -C /workspace commit --quiet --message source-gate-snapshot
docker exec "$container" pnpm install --frozen-lockfile

if (( $# == 0 )); then
  docker exec "$container" /usr/local/bin/dim-source-gate-run
else
  docker exec "$container" /usr/local/bin/dim-source-gate-run "$@"
fi
