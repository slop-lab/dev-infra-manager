#!/usr/bin/env bash
set -euo pipefail

image="${DIM_CONTAINER_TEST_IMAGE:-alpine:3.22}"
container="dim-container-cgroup-$PPID-$$"

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run \
  --detach \
  --name "$container" \
  --runtime runc \
  --cpus 0.5 \
  --memory 128m \
  --memory-swap 128m \
  --pids-limit 64 \
  "$image" \
  sleep 300 >/dev/null

assert_cgroup_value() {
  local file="$1"
  local expected="$2"
  local actual
  actual="$(docker exec "$container" cat "/sys/fs/cgroup/$file")"
  if [[ "$actual" != "$expected" ]]; then
    echo "unexpected $file: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

assert_cgroup_value cpu.max "50000 100000"
assert_cgroup_value memory.max "134217728"
assert_cgroup_value memory.swap.max "0"
assert_cgroup_value pids.max "64"

docker update \
  --cpus 1 \
  --memory 192m \
  --memory-swap 192m \
  --pids-limit 96 \
  "$container" >/dev/null

assert_cgroup_value cpu.max "100000 100000"
assert_cgroup_value memory.max "201326592"
assert_cgroup_value memory.swap.max "0"
assert_cgroup_value pids.max "96"

echo "container-cgroup-smoke-ok (leaf limits verified; ancestor cgroups may impose lower effective limits)"
