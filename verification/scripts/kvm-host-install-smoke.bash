#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
launcher="${DIM_QEMU_TRUSTED_LAUNCHER:-$repository_root/.dim/qemu-verify.bash}"
service="$repository_root/.dim/qemu-service.mjs"
owner="$repository_root/.dim/qemu-service-owner.mjs"
client="$repository_root/.dim/qemu-client.mjs"
root_modules=(
  qemu-input-handoff.mjs
  qemu-owner-record.mjs
  qemu-process-group.mjs
  qemu-run-finalization.mjs
  qemu-service-artifacts.mjs
  qemu-service-filesystem.mjs
  qemu-service-http.mjs
  qemu-service-owner.mjs
  qemu-service-startup.mjs
  qemu-service.mjs
  qemu-snapshot.mjs
)
node="$(command -v node 2>/dev/null)" || { echo "Node.js is required for QEMU verification" >&2; exit 2; }
node="$(/usr/bin/readlink -f -- "$node")"
invoking_uid="$(/usr/bin/id -u)"
invoking_gid="$(/usr/bin/id -g)"
IFS=: read -r invoking_user _ passwd_uid _ _ invoking_home _ < <(/usr/bin/getent passwd "$invoking_uid") || {
  echo "invoking user $invoking_uid is not present in the passwd database" >&2
  exit 2
}
[[ "$passwd_uid" == "$invoking_uid" && "$invoking_uid" != 0 ]] || {
  echo "run QEMU host verification as a non-root invoking user" >&2
  exit 2
}

if [[ ! -r "$launcher" ]]; then
  echo "protected QEMU verification launcher is not readable: $launcher" >&2
  echo "assemble the root repository at $repository_root/project or set DIM_QEMU_TRUSTED_LAUNCHER" >&2
  exit 2
fi
for file in "$client" "${root_modules[@]/#/$repository_root/.dim/}"; do
  test -r "$file" || { echo "protected QEMU verification component is not readable: $file" >&2; exit 2; }
done
if [[ ! -f "$node" || ! -x "$node" ]] ||
  [[ "$(/usr/bin/stat -Lc '%u:%g:%a' -- "$node")" != 0:0:755 ]]; then
  echo "QEMU service requires a root:root mode-0755 Node.js interpreter: $node" >&2
  exit 2
fi
test -x /usr/bin/setpriv || { echo "util-linux setpriv is required for QEMU verification" >&2; exit 2; }

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

if [[ -e "$service_dir" || -L "$service_dir" ]]; then
  echo "refusing pre-existing QEMU service path: $service_dir" >&2
  exit 1
fi
sudo_command=/usr/bin/sudo
if [[ ! -x "$sudo_command" ]]; then
  echo "sudo is required for the root-owned QEMU verification service" >&2
  exit 2
fi
"$sudo_command" -n /usr/bin/true >/dev/null 2>&1 || {
  echo "passwordless sudo is required for the root-owned QEMU verification service; sudo -n preflight failed" >&2
  exit 2
}
"$sudo_command" -n /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root /bin/sh -eu -c '
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
  "$sudo_command" -n /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
    "$node" "$owner" "$@"
}

process_start_ticks() {
  local pid="$1" stat_text fields
  stat_text="$(<"/proc/$pid/stat")" || return 1
  fields="${stat_text##*) }"
  /usr/bin/awk '{ print $20 }' <<<"$fields"
}

launch_process_matches() {
  local pid="$service_launch_pid"
  [[ "$pid" =~ ^[1-9][0-9]*$ && -n "$service_launch_start_ticks" ]] || return 1
  [[ -r "/proc/$pid/status" && -r "/proc/$pid/stat" && -e "/proc/$pid/cwd" && -e "/proc/$pid/exe" ]] || return 1
  [[ "$(process_start_ticks "$pid")" == "$service_launch_start_ticks" ]] || return 1
  [[ "$(/usr/bin/awk '$1 == "Uid:" { print $2; exit }' "/proc/$pid/status")" == 0 ]] || return 1
  [[ "$(/usr/bin/stat -Lc '%d:%i' -- "/proc/$pid/cwd")" == "$service_dir_identity" ]] || return 1
  [[ "$(/usr/bin/readlink -f -- "/proc/$pid/exe")" == "$(/usr/bin/readlink -f -- "$node")" ]] || return 1
}

terminate_exact_launch_process() {
  if ! /bin/kill -0 "$service_launch_pid" 2>/dev/null; then return 0; fi
  launch_process_matches || {
    echo "refusing to signal QEMU service PID $service_launch_pid after its process identity changed" >&2
    return 1
  }
  "$sudo_command" -n /bin/kill -TERM -- "$service_launch_pid" || return 1
  for _ in $(seq 1 100); do
    /bin/kill -0 "$service_launch_pid" 2>/dev/null || return 0
    sleep 0.05
  done
  launch_process_matches || {
    echo "refusing to force-stop QEMU service PID $service_launch_pid after its process identity changed" >&2
    return 1
  }
  "$sudo_command" -n /bin/kill -KILL -- "$service_launch_pid"
}

remove_service_directory() {
  "$sudo_command" -n /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root /bin/sh -eu -c '
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

cleanup() {
  local status=$? cleanup_status=0 current_identity=""
  trap - EXIT
  set +e
  if [[ -n "$service_fingerprint" ]]; then
    root_owner retire-exact "$owner_path" "$service_socket" "$service_dir" 10000 "$service_fingerprint" || cleanup_status=1
  fi
  if [[ -n "$service_launch_pid" ]] && /bin/kill -0 "$service_launch_pid" 2>/dev/null; then
    terminate_exact_launch_process || cleanup_status=1
  fi
  if [[ -n "$service_wrapper_pid" ]]; then
    wait "$service_wrapper_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$launcher_wrapper_source" ]]; then
    /usr/bin/rm -f -- "$launcher_wrapper_source" || cleanup_status=1
  fi
  if [[ -e "$service_dir" || -L "$service_dir" ]]; then
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

"$sudo_command" -n /usr/bin/install -d -o root -g root -m 0555 "$service_dir/modules"
for module in "${root_modules[@]}"; do
  "$sudo_command" -n /usr/bin/install -o root -g root -m 0444 \
    "$repository_root/.dim/$module" "$service_dir/modules/$module"
done
service="$service_dir/modules/qemu-service.mjs"
owner="$service_dir/modules/qemu-service-owner.mjs"
"$sudo_command" -n /usr/bin/install -o root -g root -m 0555 "$launcher" "$service_dir/gate.bash"
launcher_wrapper_source="$(/usr/bin/mktemp)"
printf '#!/usr/bin/env bash\nexec /usr/bin/setpriv --reuid %q --regid %q --init-groups -- /usr/bin/env HOME=%q USER=%q LOGNAME=%q /bin/bash %q "$@"\n' \
  "$invoking_uid" "$invoking_gid" "$invoking_home" "$invoking_user" "$invoking_user" "$service_dir/gate.bash" \
  >"$launcher_wrapper_source"
"$sudo_command" -n /usr/bin/install -o root -g root -m 0555 "$launcher_wrapper_source" "$service_dir/launcher.bash"
/usr/bin/rm -f -- "$launcher_wrapper_source"
launcher_wrapper_source=""
source_root="$repository_root"
image_cache="${DIM_KVM_IMAGE_CACHE:-$repository_root/.local/kvm}"
"$sudo_command" -n /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
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
  if [[ -r "$launch_pid_path" ]]; then
    service_launch_pid="$(<"$launch_pid_path")"
    [[ "$service_launch_pid" =~ ^[1-9][0-9]*$ ]] || { echo "invalid QEMU service launch PID" >&2; exit 1; }
    service_launch_start_ticks="$(process_start_ticks "$service_launch_pid")"
    launch_process_matches || { echo "QEMU service launch identity is invalid" >&2; exit 1; }
    break
  fi
  /bin/kill -0 "$service_wrapper_pid" 2>/dev/null || { wait "$service_wrapper_pid" || true; break; }
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
  /bin/kill -0 "$service_launch_pid" 2>/dev/null || break
  sleep 0.1
done
[[ -n "$service_fingerprint" && -S "$service_socket" ]] || {
  cat "$service_log" >&2
  echo "timed out waiting for root-owned protected QEMU verification service" >&2
  exit 1
}

DIM_QEMU_VERIFICATION_SOCKET="$service_socket" node "$client" run "$@"
