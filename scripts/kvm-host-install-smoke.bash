#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
launcher="${DIM_QEMU_TRUSTED_LAUNCHER:-$repository_root/project/.dim/qemu-verify.bash}"
service="$repository_root/project/.dim/qemu-service.mjs"
client="$repository_root/project/.dim/qemu-client.mjs"

if [[ ! -r "$launcher" ]]; then
  echo "protected QEMU verification launcher is not readable: $launcher" >&2
  echo "assemble the root repository at $repository_root/project or set DIM_QEMU_TRUSTED_LAUNCHER" >&2
  exit 2
fi
for file in "$service" "$client"; do
  test -r "$file" || { echo "protected QEMU verification component is not readable: $file" >&2; exit 2; }
done

service_dir="$repository_root/.local/qemu-gate.$$"
mkdir -p "$service_dir"
service_pid=""
cleanup() {
  if [[ -n "$service_pid" ]]; then
    kill "$service_pid" >/dev/null 2>&1 || true
    wait "$service_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$service_dir"
}
trap cleanup EXIT

install -m 0500 "$launcher" "$service_dir/launcher.bash"
export DIM_QEMU_SOURCE_ROOT="${DIM_QEMU_SOURCE_ROOT:-$repository_root}"
export DIM_QEMU_LAUNCHER="$service_dir/launcher.bash"
export DIM_QEMU_SERVICE_SOCKET="$service_dir/service.sock"
export DIM_QEMU_VERIFICATION_SOCKET="$service_dir/service.sock"
export DIM_KVM_IMAGE_CACHE="${DIM_KVM_IMAGE_CACHE:-$repository_root/.local/kvm}"

node "$service" >"$service_dir/service.log" 2>&1 &
service_pid=$!
for _ in $(seq 1 100); do
  [[ -S "$DIM_QEMU_SERVICE_SOCKET" ]] && break
  kill -0 "$service_pid" 2>/dev/null || {
    cat "$service_dir/service.log" >&2
    exit 1
  }
  sleep 0.1
done
[[ -S "$DIM_QEMU_SERVICE_SOCKET" ]] || {
  cat "$service_dir/service.log" >&2
  echo "timed out waiting for protected QEMU verification service" >&2
  exit 1
}

node "$client" run "$@"
