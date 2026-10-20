#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
launcher="${DIM_QEMU_TRUSTED_LAUNCHER:-$repository_root/tests/scenarios/qemu/qemu-verify.bash}"
service="$repository_root/tests/scenarios/qemu/qemu-service.mts"
owner="$repository_root/tests/scenarios/qemu/qemu-service-owner.mts"
client="$repository_root/tests/scenarios/qemu/qemu-client.mts"
root_modules=(
  qemu-event-followers.mts
  qemu-input-handoff.mts
  qemu-values.mts
  qemu-owner-record.mts
  qemu-process-group.mts
  qemu-run-finalization.mts
  qemu-service-artifacts.mts
  qemu-service-filesystem.mts
  qemu-service-http.mts
  qemu-service-owner.mts
  qemu-service-startup.mts
  qemu-service.mts
  qemu-snapshot.mts
)
node="${DIM_QEMU_NODE_EXECUTABLE:-/usr/bin/node}"
sudo_command=/usr/bin/sudo
setpriv_command=/usr/bin/setpriv
kvm_device=/dev/kvm
runtime_path=/usr/bin:/bin
sudo_keepalive_interval_seconds=30
sudo_operation_timeout_seconds=15
preflight_only=false
if [[ "${1:-}" == --preflight-only ]]; then
  preflight_only=true
  shift
fi
invoking_uid="$(/usr/bin/id -u)"
invoking_gid="$(/usr/bin/id -g)"
source "$repository_root/scripts/checks/lib/kvm-host-prerequisites.bash"
qemu_host_preflight || exit 2
if [[ "$preflight_only" == true ]]; then
  printf 'QEMU host prerequisite preflight passed\n'
  exit 0
fi

service_dir="/run/dim-qemu-host-install-smoke-$(/usr/bin/id -u)-$$"
service_socket="$service_dir/service.sock"
owner_path="$service_dir/service-owner.json"
launch_pid_path="$service_dir/launch.pid"
service_log="$service_dir/service.log"
service_wrapper_pid=""
service_launch_pid=""
service_launch_start_ticks=""
service_fingerprint=""
service_dir_identity=""
launcher_wrapper_source=""
sudo_keepalive_pid=""
client_pid=""

process_is_live() {
  local pid="$1" stat_text fields state
  [[ "$pid" =~ ^[1-9][0-9]*$ && -r "/proc/$pid/stat" ]] || return 1
  stat_text="$(<"/proc/$pid/stat")" || return 1
  fields="${stat_text##*) }"
  state="${fields%% *}"
  [[ "$state" != Z && "$state" != X ]]
}

wait_for_child_exit() {
  local pid="$1"
  for _ in $(seq 1 100); do
    if ! process_is_live "$pid"; then
      wait "$pid" >/dev/null 2>&1 || true
      return 0
    fi
    sleep 0.05
  done
  return 1
}

run_sudo_once() {
  /usr/bin/timeout --signal=KILL --kill-after=1 "${sudo_operation_timeout_seconds}s" \
    "$sudo_command" -n "$@"
}

if [[ -e "$service_dir" || -L "$service_dir" ]]; then
  echo "refusing pre-existing QEMU service path: $service_dir" >&2
  exit 1
fi
run_sudo_once /usr/bin/env -i "PATH=$runtime_path" HOME=/root /bin/sh -eu -c '
  test ! -e "$1" && test ! -L "$1"
  /usr/bin/mkdir -- "$1"
  /usr/bin/chown root:root -- "$1"
  /usr/bin/chmod 0755 -- "$1"
' qemu-service-directory "$service_dir"
if [[ -L "$service_dir" || ! -d "$service_dir" ]] ||
  [[ "$(/usr/bin/stat -Lc '%u:%g:%a' -- "$service_dir")" != 0:0:755 ]]; then
  echo "QEMU service directory must be a real root:root mode-0755 directory: $service_dir" >&2
  exit 1
fi
service_dir_identity="$(/usr/bin/stat -Lc '%d:%i' -- "$service_dir")"

root_owner() {
  run_sudo_once /usr/bin/env -i "PATH=$runtime_path" HOME=/root \
    "$node" "$owner" "$@"
}

process_start_ticks() {
  local pid="$1" stat_text fields
  stat_text="$(<"/proc/$pid/stat")" || return 1
  fields="${stat_text##*) }"
  /usr/bin/awk '{ print $20 }' <<<"$fields"
}

read_launch_pid() {
  [[ ! -L "$launch_pid_path" && -f "$launch_pid_path" ]] || return 1
  [[ "$(/usr/bin/stat -Lc '%u:%g:%a:%h' -- "$launch_pid_path")" == 0:0:600:1 ]] || return 1
  run_sudo_once /bin/cat -- "$launch_pid_path"
}

launch_process_matches() {
  local pid="$service_launch_pid"
  [[ "$pid" =~ ^[1-9][0-9]*$ && -n "$service_launch_start_ticks" ]] || return 1
  run_sudo_once /usr/bin/env -i "PATH=$runtime_path" HOME=/root /bin/sh -eu -c '
    pid="$1"
    expected_start="$2"
    expected_cwd="$3"
    expected_executable="$4"
    test -r "/proc/$pid/status" && test -r "/proc/$pid/stat"
    test -e "/proc/$pid/cwd" && test -e "/proc/$pid/exe"
    stat_text="$(/bin/cat -- "/proc/$pid/stat")"
    fields="${stat_text##*) }"
    set -- $fields
    start="${20}"
    test "$start" = "$expected_start"
    test "$(/usr/bin/awk '\''$1 == "Uid:" { print $2; exit }'\'' "/proc/$pid/status")" = 0
    test "$(/usr/bin/stat -Lc "%d:%i" -- "/proc/$pid/cwd")" = "$expected_cwd"
    test "$(/usr/bin/readlink -f -- "/proc/$pid/exe")" = "$expected_executable"
  ' qemu-launch-identity "$pid" "$service_launch_start_ticks" "$service_dir_identity" \
    "$(/usr/bin/readlink -f -- "$node")"
}

terminate_exact_launch_process() {
  if ! process_is_live "$service_launch_pid"; then return 0; fi
  launch_process_matches || {
    echo "refusing to signal QEMU service PID $service_launch_pid after its process identity changed" >&2
    return 1
  }
  if ! run_sudo_once /bin/kill -TERM -- "$service_launch_pid"; then
    launch_process_exited
    return "$?"
  fi
  for _ in $(seq 1 100); do
    process_is_live "$service_launch_pid" || return 0
    sleep 0.05
  done
  launch_process_matches || {
    echo "refusing to force-stop QEMU service PID $service_launch_pid after its process identity changed" >&2
    return 1
  }
  if ! run_sudo_once /bin/kill -KILL -- "$service_launch_pid"; then
    launch_process_exited
    return "$?"
  fi
}

# A clean service exit can race the signal after the identity check. Only a
# missing PID or the exact launch's terminal state proves this harmless; a
# replacement, a live process or an unreadable identity remains a failure.
launch_process_exited() {
  run_sudo_once /usr/bin/env -i "PATH=$runtime_path" HOME=/root "$node" --input-type=commonjs -e '
    const fs = require("node:fs"), pid = process.argv[1], expected = process.argv[2];
    if (!/^[1-9][0-9]*$/.test(pid) || !/^[0-9]+$/.test(expected)) process.exit(1);
    let snapshot;
    try { snapshot = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); }
    catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") process.exit(0); throw error; }
    const fields = snapshot.slice(snapshot.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (fields[19] !== expected) process.exit(1);
    process.exit(fields[0] === "Z" || fields[0] === "X" ? 0 : 1);
  ' "$service_launch_pid" "$service_launch_start_ticks"
}

remove_service_directory() {
  run_sudo_once /usr/bin/env -i "PATH=$runtime_path" HOME=/root /bin/sh -eu -c '
    path="$1"
    expected="$2"
    test ! -L "$path" && test -d "$path"
    test "$(/usr/bin/stat -Lc "%d:%i" -- "$path")" = "$expected"
    test "$(/usr/bin/stat -Lc "%u:%g:%a" -- "$path")" = 0:0:755
    quarantine="${path}.removing-$$"
    test ! -e "$quarantine" && test ! -L "$quarantine"
    /usr/bin/mv -T -- "$path" "$quarantine"
    moved="$(/usr/bin/stat -Lc "%d:%i" -- "$quarantine")"
    if test "$moved" != "$expected"; then
      if test ! -e "$path" && test ! -L "$path"; then /usr/bin/mv -T -- "$quarantine" "$path"; fi
      exit 1
    fi
    /usr/bin/rm -rf -- "$quarantine"
  ' qemu-service-directory-cleanup "$service_dir" "$service_dir_identity"
}

sudo_keepalive() {
  while /bin/sleep "$sudo_keepalive_interval_seconds"; do
    if ! /usr/bin/timeout --signal=KILL --kill-after=1 5s "$sudo_command" -n -v; then
      echo "sudo authorization refresh failed; stopping QEMU verification" >&2
      return 1
    fi
  done
}

stop_sudo_keepalive() {
  [[ -n "$sudo_keepalive_pid" ]] || return 0
  if process_is_live "$sudo_keepalive_pid"; then
    /bin/kill -TERM -- "$sudo_keepalive_pid" 2>/dev/null || true
  fi
  if ! wait_for_child_exit "$sudo_keepalive_pid"; then
    /bin/kill -KILL -- "$sudo_keepalive_pid" 2>/dev/null || true
    wait_for_child_exit "$sudo_keepalive_pid" || return 1
  fi
  sudo_keepalive_pid=""
}

run_client() {
  local completed="" first_status=0
  DIM_QEMU_VERIFICATION_SOCKET="$service_socket" "$node" "$client" run "$@" &
  client_pid=$!
  if wait -n -p completed "$client_pid" "$sudo_keepalive_pid"; then
    first_status=0
  else
    first_status=$?
  fi
  if [[ "$completed" == "$sudo_keepalive_pid" ]]; then
    if process_is_live "$client_pid"; then /bin/kill -TERM -- "$client_pid" 2>/dev/null || true; fi
    if ! wait_for_child_exit "$client_pid"; then
      /bin/kill -KILL -- "$client_pid" 2>/dev/null || true
      wait_for_child_exit "$client_pid" || true
    fi
    client_pid=""
    return 1
  fi
  client_pid=""
  return "$first_status"
}

cleanup() {
  local status=$? cleanup_status=0 current_identity="" service_shutdown_proven=true
  trap - EXIT
  set +e
  stop_sudo_keepalive || cleanup_status=1
  if [[ -n "$service_fingerprint" ]]; then
    root_owner retire-exact "$owner_path" "$service_socket" "$service_dir" 10000 "$service_fingerprint" || cleanup_status=1
  fi
  if [[ -n "$service_launch_pid" ]] && process_is_live "$service_launch_pid"; then
    terminate_exact_launch_process || cleanup_status=1
  fi
  if [[ -n "$service_launch_pid" ]] && ! wait_for_child_exit "$service_launch_pid"; then
    service_shutdown_proven=false
    cleanup_status=1
  fi
  if [[ -n "$service_wrapper_pid" && "$service_wrapper_pid" != "$service_launch_pid" ]] &&
    ! wait_for_child_exit "$service_wrapper_pid"; then
    service_shutdown_proven=false
    cleanup_status=1
  fi
  if [[ -n "$launcher_wrapper_source" ]]; then
    /usr/bin/rm -f -- "$launcher_wrapper_source" || cleanup_status=1
  fi
  if [[ "$service_shutdown_proven" != true && ( -e "$service_dir" || -L "$service_dir" ) ]]; then
    echo "leaving QEMU service directory intact because service shutdown was not proven: $service_dir" >&2
  elif [[ -e "$service_dir" || -L "$service_dir" ]]; then
    if [[ ! -L "$service_dir" && -d "$service_dir" ]]; then
      current_identity="$(/usr/bin/stat -Lc '%d:%i' -- "$service_dir" 2>/dev/null)"
    fi
    if [[ "$current_identity" == "$service_dir_identity" ]] &&
      [[ "$(/usr/bin/stat -Lc '%u:%g:%a' -- "$service_dir" 2>/dev/null)" == 0:0:755 ]]; then
      remove_service_directory || cleanup_status=1
    else
      echo "refusing to remove replaced QEMU service path: $service_dir" >&2
      cleanup_status=1
    fi
  fi
  if (( status != 0 )); then exit "$status"; fi
  exit "$cleanup_status"
}
trap cleanup EXIT

sudo_keepalive &
sudo_keepalive_pid=$!

run_sudo_once /usr/bin/install -d -o root -g root -m 0555 "$service_dir/modules"
for module in "${root_modules[@]}"; do
  run_sudo_once /usr/bin/install -o root -g root -m 0444 \
    "$repository_root/tests/scenarios/qemu/$module" "$service_dir/modules/$module"
done
service="$service_dir/modules/qemu-service.mts"
owner="$service_dir/modules/qemu-service-owner.mts"
run_sudo_once /usr/bin/install -o root -g root -m 0555 "$launcher" "$service_dir/gate.bash"
launcher_wrapper_source="$(/usr/bin/mktemp)"
printf '#!/usr/bin/env bash\nexec %q --reuid %q --regid %q --init-groups -- /usr/bin/env HOME=%q USER=%q LOGNAME=%q /bin/bash %q "$@"\n' \
  "$setpriv_command" \
  "$invoking_uid" "$invoking_gid" "$invoking_home" "$invoking_user" "$invoking_user" "$service_dir/gate.bash" \
  >"$launcher_wrapper_source"
run_sudo_once /usr/bin/install -o root -g root -m 0555 "$launcher_wrapper_source" "$service_dir/launcher.bash"
/usr/bin/rm -f -- "$launcher_wrapper_source"
launcher_wrapper_source=""
source_root="$repository_root"
image_cache="${DIM_KVM_IMAGE_CACHE:-$repository_root/.local/kvm}"
"$sudo_command" -n /usr/bin/env -i "PATH=$runtime_path" HOME=/root \
  DIM_QEMU_SOURCE_ROOT="$source_root" DIM_QEMU_LAUNCHER="$service_dir/launcher.bash" \
  DIM_QEMU_INVOKING_UID="$invoking_uid" DIM_QEMU_INVOKING_GID="$invoking_gid" \
  DIM_KVM_IMAGE_CACHE="$image_cache" DIM_QEMU_SERVICE_SOCKET="$service_socket" \
  /bin/sh -c '
    cd "$1"
    umask 077
    printf "%s\n" "$$" >"$3"
    exec "$5" "$2" >"$4" 2>&1
  ' qemu-service "$service_dir" "$service" "$launch_pid_path" "$service_log" "$node" &
service_wrapper_pid=$!

for _ in $(seq 1 100); do
  if [[ -e "$launch_pid_path" || -L "$launch_pid_path" ]]; then
    service_launch_pid="$(read_launch_pid)" || { echo "QEMU service launch PID file is unsafe or unreadable" >&2; exit 1; }
    [[ "$service_launch_pid" =~ ^[1-9][0-9]*$ ]] || { echo "invalid QEMU service launch PID" >&2; exit 1; }
    service_launch_start_ticks="$(process_start_ticks "$service_launch_pid")"
    launch_process_matches || { echo "QEMU service launch identity is invalid" >&2; exit 1; }
    break
  fi
  process_is_live "$service_wrapper_pid" || { wait "$service_wrapper_pid" || true; break; }
  sleep 0.05
done
[[ -n "$service_launch_pid" ]] || {
  [[ -r "$service_log" ]] && cat "$service_log" >&2
  echo "QEMU service did not publish its exact launch PID" >&2
  exit 1
}

for _ in $(seq 1 100); do
  candidate="$(root_owner inspect "$owner_path" "$service_socket" "$service_dir" 2>/dev/null)" || candidate=""
  owner_pid="$(printf '%s' "$candidate" | "$node" -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk).on("end", () => {
      const value = JSON.parse(input);
      if (value.state !== "live" || typeof value.pid !== "string") process.exit(1);
      process.stdout.write(value.pid);
    });
  ' 2>/dev/null)" || owner_pid=""
  if [[ "$owner_pid" == "$service_launch_pid" ]] && launch_process_matches &&
    [[ "$(/usr/bin/stat -Lc '%d:%i' -- "$service_dir" 2>/dev/null)" == "$service_dir_identity" ]] &&
    [[ "$(/usr/bin/stat -Lc '%u:%g:%a' -- "$owner_path" 2>/dev/null)" == 0:0:600 ]] &&
    [[ "$(/usr/bin/stat -Lc '%u:%g:%a' -- "$service_socket" 2>/dev/null)" == 0:0:666 ]]; then
    service_fingerprint="$candidate"
    break
  fi
  process_is_live "$service_launch_pid" || break
  sleep 0.1
done
[[ -n "$service_fingerprint" && -S "$service_socket" ]] || {
  cat "$service_log" >&2
  echo "timed out waiting for root-owned protected QEMU verification service" >&2
  exit 1
}

run_client "$@"
