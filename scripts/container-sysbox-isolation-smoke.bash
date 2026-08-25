#!/usr/bin/env bash
set -euo pipefail

verbose=false
for arg in "$@"; do
  case "$arg" in
    --) ;;
    -v|--verbose) verbose=true ;;
    *) echo "usage: $0 [-v|--verbose]" >&2; exit 2 ;;
  esac
done

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

tmpdir="$(mktemp -d /tmp/dim-sysbox-isolation-XXXXXX)"
probe_suffix="$$-$(date +%s)"
host_probe_image="dim-host-only-probe:${probe_suffix}"
inner_probe_image="dim-inner-only-probe:${probe_suffix}"
nested_smoke_container="dim-sysbox-isolation-${probe_suffix}"
step_log="$tmpdir/step.log"
current_step="startup"
exec 3>&1 4>&2
step() {
  current_step="$1"
  echo "[sysbox-isolation] $current_step" >&3
  if [[ "$verbose" == false ]]; then
    exec >"$step_log" 2>&1
  fi
}
show_failure() {
  local status=$?
  trap - ERR
  echo "[sysbox-isolation] failed: $current_step" >&4
  if [[ "$verbose" == false && -s "$step_log" ]]; then
    cat "$step_log" >&4
  fi
  exit "$status"
}
trap show_failure ERR
cleanup() {
  set +e
  docker rm -f "$nested_smoke_container" >/dev/null 2>&1
  docker rm -f dim-smoke-secret >/dev/null 2>&1
  docker image rm -f "$host_probe_image" >/dev/null 2>&1
  rm -rf "$tmpdir"
}
trap cleanup EXIT

# Use unique tags so the isolation assertions never depend on which images the
# host or inner daemon happened to cache before this smoke run.
step "verify nested Docker isolation and resource limits"
docker tag dev-infra-project-workspace:latest "$host_probe_image"
docker run --rm \
  --name "$nested_smoke_container" \
  --runtime sysbox-runc \
  --cpus 1 \
  --memory 256m \
  --pids 128 \
  --env HOST_PROBE_IMAGE="$host_probe_image" \
  --env INNER_PROBE_IMAGE="$inner_probe_image" \
  dev-infra-project-workspace:latest \
  bash -lc '
    ! docker image inspect "$HOST_PROBE_IMAGE" >/dev/null 2>&1
    read -r cpu_quota cpu_period < /sys/fs/cgroup/cpu.max
    test "$cpu_quota" != max
    test "$cpu_quota" -eq "$cpu_period"
    test "$(cat /sys/fs/cgroup/memory.max)" -eq 268435456
    test "$(cat /sys/fs/cgroup/pids.max)" -eq 128
    docker run --rm hello-world | grep -q "Hello from Docker"
    docker tag hello-world:latest "$INNER_PROBE_IMAGE"
  '

if docker image inspect "$inner_probe_image" >/dev/null 2>&1; then
  echo "inner Docker image leaked into the host image store: $inner_probe_image" >&2
  exit 1
fi

echo "[sysbox-isolation] ok" >&3
