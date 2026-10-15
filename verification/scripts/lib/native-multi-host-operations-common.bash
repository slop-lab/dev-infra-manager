#!/usr/bin/env bash

ops_die() {
  printf 'native-multi-host-operations: %s\n' "$1" >&2
  exit "${2:-1}"
}

ops_known_key() {
  local candidate="$1" key
  for key in "${OPS_ALL_KEYS[@]}"; do [[ "$candidate" == "$key" ]] && return 0; done
  return 1
}

ops_require_config() {
  local config="$1" metadata line key value required
  [[ "$config" = /* && -f "$config" && ! -L "$config" ]] ||
    ops_die 'operator config must be an absolute caller-owned mode-0600 regular file' 2
  metadata="$(stat -Lc '%a:%h:%u' -- "$config")"
  [[ "$metadata" == "600:1:$(id -u)" ]] ||
    ops_die 'operator config must be an absolute caller-owned mode-0600 regular file' 2
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || ops_die 'operator config line is not KEY=VALUE' 2
    key="${line%%=*}"; value="${line#*=}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ && -n "$value" && "$value" != *[$'\t\r\n']* ]] ||
      ops_die 'operator config contains an invalid key or value' 2
    ops_known_key "$key" || ops_die "operator config contains unknown key '$key'" 2
    [[ -z "${OPS_CONFIG[$key]+x}" ]] || ops_die "operator config repeats '$key'" 2
    OPS_CONFIG[$key]="$value"
  done <"$config"
  for required in "${OPS_REQUIRED_KEYS[@]}"; do
    [[ -n "${OPS_CONFIG[$required]:-}" ]] || ops_die "operator config is missing '$required'" 2
  done
  ops_validate_config
}

ops_validate_config() {
  local key
  for key in EXPECTED_COMMIT PROJECT_COMMIT; do
    [[ "${OPS_CONFIG[$key]}" =~ ^[0-9a-f]{40}$ ]] || ops_die "$key must be 40 lowercase hex" 2
  done
  [[ "${OPS_CONFIG[CONTROL_SSH]}" =~ ^[A-Za-z0-9_.@-]+$ &&
     "${OPS_CONFIG[ORDINARY_SSH]}" =~ ^[A-Za-z0-9_.@-]+$ ]] ||
    ops_die 'SSH endpoints must be aliases or user@host names without options' 2
  for key in "${OPS_PATH_KEYS[@]}"; do
    [[ "${OPS_CONFIG[$key]}" =~ ^/[A-Za-z0-9_./:@+-]+$ ]] ||
      ops_die "$key must be an absolute path without remote-shell metacharacters" 2
  done
  for key in "${OPS_IDENTIFIER_KEYS[@]}"; do
    [[ "${OPS_CONFIG[$key]}" =~ ^[a-z0-9][a-z0-9._-]{0,127}$ ]] || ops_die "$key is invalid" 2
  done
  for key in PROJECT_NAME WORKSPACE_NAME; do
    [[ "${OPS_CONFIG[$key]}" =~ ^[a-z0-9][a-z0-9._-]{0,47}$ ]] || ops_die "$key is invalid" 2
  done
  [[ "${OPS_CONFIG[PROJECT_ID]}" =~ ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$ ]] ||
    ops_die 'PROJECT_ID is invalid' 2
  for key in ORDINARY_JOB QEMU_JOB; do
    [[ "${OPS_CONFIG[$key]}" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || ops_die "$key is invalid" 2
  done
  for key in "${OPS_UNIT_KEYS[@]}"; do
    [[ "${OPS_CONFIG[$key]}" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || ops_die "$key is invalid" 2
  done
  for key in "${OPS_CONTAINER_KEYS[@]}"; do
    [[ "${OPS_CONFIG[$key]}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]+$ ]] || ops_die "$key is invalid" 2
  done
  [[ "${OPS_CONFIG[PROJECT_REF]}" =~ ^refs/heads/[A-Za-z0-9._/-]+$ &&
     "${OPS_CONFIG[PROJECT_REF]}" != *'/../'* && "${OPS_CONFIG[PROJECT_REF]}" != *'/./'* ]] ||
    ops_die 'PROJECT_REF must be a safe full branch ref' 2
  [[ "${OPS_CONFIG[PROTECTED_QEMU_MODE]}" == unused ]] ||
    ops_die 'set PROTECTED_QEMU_MODE=unused; operations never use protected verification authority' 2
  [[ "${OPS_CONFIG[DISPOSABLE_EXCLUSIVE_NODES_ACK]}" == control-qemu-and-ordinary ]] ||
    ops_die 'set DISPOSABLE_EXCLUSIVE_NODES_ACK=control-qemu-and-ordinary for exclusive disposable nodes' 2
  [[ "${OPS_CONFIG[QEMU_SCHEDULER_UNIT]}" != "${OPS_CONFIG[QEMU_HOST_UNIT]}" ]] ||
    ops_die 'QEMU units must differ' 2
  [[ "${OPS_CONFIG[ORDINARY_JOB]}" != "${OPS_CONFIG[QEMU_JOB]}" ]] ||
    ops_die 'ordinary and QEMU jobs must differ' 2
}

ops_ssh() {
  local target="$1"
  shift
  ssh -o BatchMode=yes -o ConnectTimeout=10 -- "$target" "$@"
}

cutover_ssh() { ops_ssh "$@"; }

ops_static_preflight() {
  declare -gA CUTOVER_CONFIG=([EXPECTED_COMMIT]="${OPS_CONFIG[EXPECTED_COMMIT]}")
  local control_files=(
    "${OPS_CONFIG[CONTROL_INSTALL_CONFIG]}" "${OPS_CONFIG[REGISTRAR_CONNECTION]}"
    "${OPS_CONFIG[IMPORTER_CONNECTION]}" "${OPS_CONFIG[CONTROL_PLANE_CONNECTION]}"
    "${OPS_CONFIG[QEMU_SCHEDULER_CONFIG]}" "${OPS_CONFIG[QEMU_HOST_CONFIG]}"
  )
  OPS_CONTROL_IDENTITY="$(cutover_remote_static_preflight "${OPS_CONFIG[CONTROL_SSH]}" control-qemu \
    "${OPS_CONFIG[CONTROL_SOURCE_ROOT]}" "${control_files[@]}")" ||
    ops_die 'control/QEMU static prerequisite failed' 2
  OPS_ORDINARY_IDENTITY="$(cutover_remote_static_preflight "${OPS_CONFIG[ORDINARY_SSH]}" ordinary \
    "${OPS_CONFIG[ORDINARY_SOURCE_ROOT]}" "${OPS_CONFIG[ORDINARY_HOST_CONFIG]}")" ||
    ops_die 'ordinary static prerequisite failed' 2
  ops_assert_node_separation "$OPS_CONTROL_IDENTITY" "$OPS_ORDINARY_IDENTITY"
}

ops_assert_node_separation() {
  local control="$1" ordinary="$2" field identity
  for field in machineId bootId dockerId stateIdentity; do
    [[ "$(jq -er ".$field" <<<"$control")" != "$(jq -er ".$field" <<<"$ordinary")" ]] ||
      ops_die "control/QEMU and ordinary nodes share $field" 2
  done
  [[ "${OPS_CONFIG[QEMU_HOST_ID]}" != "${OPS_CONFIG[ORDINARY_HOST_ID]}" ]] ||
    ops_die 'ordinary and QEMU host IDs must differ' 2
  for identity in "$control" "$ordinary"; do
    jq -er '.preparedImageId | select(test("^sha256:[0-9a-f]{64}$"))' <<<"$identity" >/dev/null ||
      ops_die 'node has invalid preparedImageId' 2
  done
  for field in commit dimVersion aggregateLockSha256 packageSha256 preparedImageRef; do
    [[ "$(jq -er ".$field" <<<"$control")" == "$(jq -er ".$field" <<<"$ordinary")" ]] ||
      ops_die "control/QEMU and ordinary nodes differ in prepared $field" 2
  done
}

ops_assert_qemu_idle() {
  local target="$1" config="$2" expected_host="$3"
  ops_ssh "$target" bash -s -- "$config" "$expected_host" <<'REMOTE'
set -euo pipefail
config="$1"; expected_host="$2"
actual_host="$(jq -er '.hostId' "$config")"
[[ "$actual_host" == "$expected_host" ]] || exit 2
capacities_json="$(jq -ce '
  .capacities |
  if type == "array" and length > 0 then map(.capacity) else error("capacities are missing") end |
  if all(.[]; type == "string" and test("^[a-z0-9][a-z0-9._-]{0,127}$"))
    then . else error("capacity name is invalid") end |
  if (unique | length) == length then . else error("capacity names are duplicated") end
' "$config")" || exit 2
mapfile -t capacities < <(jq -r '.[]' <<<"$capacities_json")
[[ -z "$(docker container ls -aq --filter label=dev.dim.native-qemu.claim)" ]]
for capacity in "${capacities[@]}"; do
  directory="/var/lib/dim-native-qemu-host/$capacity"
  [[ ! -e "$directory/journal.json" && ! -L "$directory/journal.json" ]]
  shopt -s nullglob; work=("$directory"/*/); ((${#work[@]} == 0))
done
REMOTE
}

ops_runtime_preflight() {
  cutover_remote_runtime_preflight "${OPS_CONFIG[ORDINARY_SSH]}" ordinary \
    "${OPS_CONFIG[ORDINARY_HOST_CONFIG]}" "${OPS_CONFIG[ORDINARY_HOST_ID]}" >/dev/null ||
    ops_die 'ordinary Sysbox runtime preflight failed' 2
  cutover_remote_runtime_preflight "${OPS_CONFIG[CONTROL_SSH]}" ordinary \
    "${OPS_CONFIG[QEMU_HOST_CONFIG]}" "${OPS_CONFIG[QEMU_HOST_ID]}" >/dev/null ||
    ops_die 'control workspace Sysbox runtime preflight failed' 2
  cutover_remote_runtime_preflight "${OPS_CONFIG[CONTROL_SSH]}" qemu \
    "${OPS_CONFIG[QEMU_HOST_CONFIG]}" "${OPS_CONFIG[QEMU_HOST_ID]}" >/dev/null ||
    ops_die 'QEMU KVM and type=image runtime preflight failed' 2
}

ops_state_preflight() {
  ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" bash -s -- "${OPS_CONFIG[PROJECT_SOURCE]}" \
    "${OPS_CONFIG[PROJECT_REF]}" "${OPS_CONFIG[PROJECT_COMMIT]}" "${OPS_CONFIG[CONTROL_PLANE_CONNECTION]}" \
    "${OPS_CONFIG[PROJECT_NAME]}" "${OPS_CONFIG[WORKSPACE_NAME]}" "${OPS_CONFIG[QEMU_SCHEDULER_UNIT]}" \
    "${OPS_CONFIG[QEMU_HOST_UNIT]}" "${OPS_CONFIG[QEMU_SCHEDULER_CONFIG]}" "${OPS_CONFIG[QEMU_HOST_CONFIG]}" \
    "${OPS_CONFIG[QEMU_HOST_ID]}" <<'REMOTE'
set -euo pipefail
[[ "$(git -C "$1" rev-parse --verify "$2^{commit}")" == "$3" ]]
[[ -z "$(git -C "$1" status --porcelain=v1 --untracked-files=all)" ]]
projects="$(DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$4" dim project list --json)"
workspaces="$(DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$4" dim workspace list --json)"
jq -e --arg name "$5" 'all(.[]; .name != $name)' <<<"$projects" >/dev/null
jq -e --arg name "$6" 'all(.[]; .name != $name)' <<<"$workspaces" >/dev/null
[[ "$(systemctl --user show --property=LoadState --value "$7")" == loaded ]]
[[ "$(systemctl --user show --property=ActiveState --value "$7")" == inactive ]]
systemctl --user show --property=ExecStart --value "$7" | grep -F -- "dim ci native-qemu scheduler run $9" >/dev/null
[[ "$(systemctl --user show --property=LoadState --value "$8")" == loaded ]]
[[ "$(systemctl --user show --property=ActiveState --value "$8")" == inactive ]]
systemctl --user show --property=ExecStart --value "$8" | grep -F -- "dim ci native-qemu host run ${11} ${10}" >/dev/null
REMOTE
  ops_assert_qemu_idle "${OPS_CONFIG[CONTROL_SSH]}" "${OPS_CONFIG[QEMU_HOST_CONFIG]}" \
    "${OPS_CONFIG[QEMU_HOST_ID]}"
  ops_ssh "${OPS_CONFIG[ORDINARY_SSH]}" bash -s -- "${OPS_CONFIG[ORDINARY_UNIT]}" \
    "${OPS_CONFIG[ORDINARY_HOST_CONFIG]}" "${OPS_CONFIG[ORDINARY_STATE_DIRECTORY]}" <<'REMOTE'
set -euo pipefail
configured_state="$(jq -er '.stateDirectory' "$2")" || exit 2
[[ "$configured_state" == "$3" ]] || exit 2
capacities_json="$(jq -ce '
  .capacities |
  if type == "array" and length > 0 then . else error("capacities are missing") end |
  if all(.[]; type == "string" and test("^[a-z0-9][a-z0-9._-]{0,127}$"))
    then . else error("capacity name is invalid") end |
  if (unique | length) == length then . else error("capacity names are duplicated") end
' "$2")" || exit 2
[[ "$(systemctl --user show --property=LoadState --value "$1")" == loaded ]]
[[ "$(systemctl --user show --property=ActiveState --value "$1")" == inactive ]]
systemctl --user show --property=ExecStart --value "$1" | grep -F -- "dim ci native-root host run $2" >/dev/null
[[ -z "$(docker container ls -aq --filter label=dim.kind=native-ordinary-runner)" ]]
shopt -s nullglob; residue=("$3"/*.json "$3"/work-* "$3"/.work-*.staging); ((${#residue[@]} == 0))
REMOTE
}

ops_preflight() {
  ops_static_preflight
  ops_runtime_preflight
  ops_state_preflight
}
