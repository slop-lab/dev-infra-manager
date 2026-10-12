#!/usr/bin/env bash

cutover_die() {
  printf 'native-cutover-clean-host-smoke: %s\n' "$1" >&2
  exit "${2:-1}"
}

cutover_require_config() {
  local config="$1" owner metadata line key value
  [[ "$config" = /* && -f "$config" && ! -L "$config" ]] ||
    cutover_die "operator config must be an absolute caller-owned mode-0600 regular file" 2
  owner="$(id -u)"
  metadata="$(stat -Lc '%a:%h:%u' -- "$config")"
  [[ "$metadata" == "600:1:$owner" ]] ||
    cutover_die "operator config must be an absolute caller-owned mode-0600 regular file" 2
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || cutover_die "operator config line is not KEY=VALUE" 2
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ && -n "$value" && "$value" != *[$'\t\r\n']* ]] ||
      cutover_die "operator config contains an invalid key or value" 2
    cutover_known_key "$key" || cutover_die "operator config contains unknown key '$key'" 2
    [[ -z "${CUTOVER_CONFIG[$key]+x}" ]] || cutover_die "operator config repeats '$key'" 2
    CUTOVER_CONFIG[$key]="$value"
  done <"$config"
  local required
  for required in "${CUTOVER_REQUIRED_KEYS[@]}"; do
    [[ -n "${CUTOVER_CONFIG[$required]:-}" ]] || cutover_die "operator config is missing '$required'" 2
  done
  [[ "${CUTOVER_CONFIG[EXPECTED_COMMIT]}" =~ ^[0-9a-f]{40}$ ]] || cutover_die "EXPECTED_COMMIT must be 40 lowercase hex" 2
  [[ "${CUTOVER_CONFIG[PROJECT_COMMIT]}" =~ ^[0-9a-f]{40}$ ]] || cutover_die "PROJECT_COMMIT must be 40 lowercase hex" 2
  [[ "${CUTOVER_CONFIG[CONTROL_SSH]}" =~ ^[A-Za-z0-9_.@-]+$ &&
     "${CUTOVER_CONFIG[ORDINARY_SSH]}" =~ ^[A-Za-z0-9_.@-]+$ ]] ||
    cutover_die "SSH endpoints must be aliases or user@host names without options" 2
  local identifier_key
  for identifier_key in PROJECT_NAME PROJECT_ID WORKSPACE_NAME ORDINARY_HOST_ID QEMU_HOST_ID ORDINARY_JOB QEMU_JOB; do
    [[ "${CUTOVER_CONFIG[$identifier_key]}" =~ ^[a-z0-9][a-z0-9._-]{0,127}$ ]] ||
      cutover_die "$identifier_key is invalid" 2
  done
  local unit_key
  for unit_key in ORDINARY_UNIT QEMU_SCHEDULER_UNIT QEMU_HOST_UNIT; do
    [[ "${CUTOVER_CONFIG[$unit_key]}" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || cutover_die "$unit_key is invalid" 2
  done
  [[ "${CUTOVER_CONFIG[NATIVE_GIT_CONTAINER]}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]+$ &&
     "${CUTOVER_CONFIG[ORDINARY_CI_CONTAINER]}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]+$ ]] ||
    cutover_die "control-plane container names are invalid" 2
  [[ "${CUTOVER_CONFIG[PROTECTED_QEMU_MODE]}" == "unused" ]] ||
    cutover_die "set PROTECTED_QEMU_MODE=unused; this gate never trusts the protected verification socket" 2
  local path_key
  for path_key in "${CUTOVER_PATH_KEYS[@]}"; do
    [[ "${CUTOVER_CONFIG[$path_key]}" = /* ]] || cutover_die "$path_key must be absolute" 2
  done
}

cutover_known_key() {
  local candidate="$1" known
  for known in "${CUTOVER_ALL_KEYS[@]}"; do [[ "$candidate" == "$known" ]] && return 0; done
  return 1
}

cutover_ssh() {
  local target="$1"
  shift
  ssh -o BatchMode=yes -o ConnectTimeout=10 -- "$target" "$@"
}

cutover_remote_static_preflight() {
  local target="$1" role="$2" source_root="$3"
  shift 3
  cutover_ssh "$target" bash -s -- "$role" "$source_root" "${CUTOVER_CONFIG[EXPECTED_COMMIT]}" "$@" <<'REMOTE'
set -euo pipefail
role="$1"; source_root="$2"; expected_commit="$3"; shift 3
for command in bash git jq docker dim just node stat sha256sum systemctl; do
  command -v "$command" >/dev/null || { printf '%s requires %s\n' "$role" "$command" >&2; exit 2; }
done
[[ "$(uname -s)" == Linux ]] || { printf '%s requires Linux\n' "$role" >&2; exit 2; }
[[ "$(git -C "$source_root" rev-parse --verify HEAD)" == "$expected_commit" ]] || {
  printf '%s source root is not expected commit %s\n' "$role" "$expected_commit" >&2; exit 2;
}
[[ -z "$(git -C "$source_root" status --porcelain=v1 --untracked-files=all)" ]] || {
  printf '%s source root is dirty; use a clean detached checkout\n' "$role" >&2; exit 2;
}
prepared_state="$source_root/.local/prepared-local.state"
[[ -f "$prepared_state" && ! -L "$prepared_state" ]] || {
  printf '%s prepared package state is missing or unsafe; rerun prepare-local\n' "$role" >&2; exit 2;
}
[[ "$(awk -F= '$1=="root" {print $2}' "$prepared_state")" == "$expected_commit" ]] || {
  printf '%s prepared package provenance is stale; run DIM_SOURCE_ROOT_COMMIT=%s just prepare-local\n' "$role" "$expected_commit" >&2; exit 2;
}
aggregate_lock_sha256="$(awk -F= '$1=="aggregate-lock-sha256" {print $2}' "$prepared_state")"
package_sha256="$(awk -F= '$1=="packages.sha256" {print $2}' "$prepared_state")"
prepared_image_ref="$(awk -F= '$1=="image.ref" {print $2}' "$prepared_state")"
prepared_image_id="$(awk -F= '$1=="image.id" {print $2}' "$prepared_state")"
[[ "$aggregate_lock_sha256" =~ ^[0-9a-f]{64}$ && "$package_sha256" =~ ^[0-9a-f]{64}$ &&
   "$prepared_image_ref" != "" && "$prepared_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  printf '%s prepared package state is invalid; rerun prepare-local\n' "$role" >&2; exit 2;
}
for path in "$@"; do
  [[ "$path" = /* ]] || { printf '%s file path is not absolute\n' "$role" >&2; exit 2; }
  [[ ! -L "$path" && "$(stat -c '%F:%a:%h:%u' -- "$path")" == "regular file:600:1:$(id -u)" ]] || {
    printf '%s requires caller-owned single-link mode-0600 file %s\n' "$role" "$path" >&2; exit 2;
  }
done
docker info >/dev/null
docker compose version >/dev/null
jq -cn --arg role "$role" --arg host "$(hostname)" --arg machine "$(cat /etc/machine-id)" \
  --arg boot "$(cat /proc/sys/kernel/random/boot_id)" --arg kernel "$(uname -srvmo)" \
  --arg daemon "$(docker info --format '{{.ID}}')" --arg source "$source_root" \
  --arg commit "$expected_commit" --arg version "$(dim --version)" \
  --arg aggregateLockSha256 "$aggregate_lock_sha256" --arg packageSha256 "$package_sha256" \
  --arg preparedImageRef "$prepared_image_ref" --arg preparedImageId "$prepared_image_id" \
  --arg state "$(cat /etc/machine-id):$(stat -Lc '%d:%i' -- "${XDG_STATE_HOME:-$HOME/.local/state}")" \
  '{role:$role,hostname:$host,machineId:$machine,bootId:$boot,kernel:$kernel,dockerId:$daemon,stateIdentity:$state,
    sourceRoot:$source,commit:$commit,dimVersion:$version,aggregateLockSha256:$aggregateLockSha256,
    packageSha256:$packageSha256,preparedImageRef:$preparedImageRef,preparedImageId:$preparedImageId}'
REMOTE
}

cutover_remote_runtime_preflight() {
  local target="$1" kind="$2" config="$3" host_id="$4"
  cutover_ssh "$target" bash -s -- "$kind" "$config" "$host_id" <<'REMOTE'
set -euo pipefail
kind="$1"; config="$2"; expected_host="$3"
actual_host="$(jq -er '.hostId' "$config")"
[[ "$actual_host" == "$expected_host" ]] || { printf 'configured host ID differs: %s != %s\n' "$actual_host" "$expected_host" >&2; exit 2; }
case "$kind" in
  ordinary)
    docker info --format '{{json .Runtimes}}' | jq -e 'has("sysbox-runc")' >/dev/null || {
      printf 'ordinary node requires sysbox-runc; install Sysbox and restart Docker\n' >&2; exit 2;
    }
    ;;
  qemu)
    [[ "$(jq -er '.nativeGit.transport' "$config")" == loopback-http ]] || exit 2
    [[ "$(jq -er '.nativeGit.endpoint' "$config")" =~ ^http://(127\.0\.0\.1|\[::1\])(:[0-9]+)?$ ]] || exit 2
    [[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] || {
      printf 'QEMU node requires readable and writable /dev/kvm; grant host KVM access\n' >&2; exit 2;
    }
    qemu-system-x86_64 -enable-kvm -machine none -nodefaults -display none
    while IFS=$'\t' read -r runner job; do
      docker image inspect "$runner" "$job" >/dev/null
      docker run --rm --read-only --network none --device /dev/kvm:/dev/kvm --entrypoint sh "$runner" -ec \
        'test -x /usr/local/bin/dim-native-qemu-run; qemu-system-x86_64 -enable-kvm -machine none -nodefaults -display none'
      docker run --rm --read-only --network none --entrypoint sh \
        --mount "type=image,src=$job,dst=/run/dim/guest-root" "$runner" -ec \
        'test -x /run/dim/guest-root/bin/bash && test -d /run/dim/guest-root/dev && test -d /run/dim/guest-root/proc && test -d /run/dim/guest-root/sys && test -d /run/dim/guest-root/run/dim/job && test -d /run/dim/guest-root/workspace'
    done < <(jq -r '.capacities[] | [.runnerBaseImage,.jobBaseImage] | @tsv' "$config")
    ;;
  *) exit 2 ;;
esac
printf '%s\n' "$actual_host"
REMOTE
}

cutover_assert_node_separation() {
  local control="$1" ordinary="$2" field
  for field in machineId bootId dockerId stateIdentity; do
    [[ "$(jq -r ".$field" <<<"$control")" != "$(jq -r ".$field" <<<"$ordinary")" ]] ||
      cutover_die "control/QEMU and ordinary nodes share $field; use independently configured Linux nodes" 2
  done
  [[ "${CUTOVER_CONFIG[QEMU_HOST_ID]}" != "${CUTOVER_CONFIG[ORDINARY_HOST_ID]}" ]] ||
    cutover_die "ordinary and QEMU host IDs must differ" 2
  for field in commit dimVersion aggregateLockSha256 packageSha256; do
    [[ "$(jq -r ".$field" <<<"$control")" == "$(jq -r ".$field" <<<"$ordinary")" ]] ||
      cutover_die "control/QEMU and ordinary nodes differ in prepared $field" 2
  done
}
