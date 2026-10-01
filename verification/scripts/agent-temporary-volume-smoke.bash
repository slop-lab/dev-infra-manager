#!/usr/bin/env bash
set -euo pipefail

image="${DIM_CONTAINER_TEST_IMAGE:-alpine:3.22}"
prefix="dim-agent-tmp-smoke-$PPID-$$"
driver_image="$prefix-driver"
agent_one="$prefix-agent-one"
agent_two="$prefix-agent-two"
temporary_volume="$prefix-opencode-tmp"
keep_volume_temporary_volume="$prefix-keep-opencode-tmp"
unrelated_volume="$prefix-unrelated"
wrong_owner_volume="$prefix-wrong-owner"
symlink_volume="$prefix-symlink"

cleanup() {
  docker rm --force "$agent_one" "$agent_two" >/dev/null 2>&1 || true
  docker volume rm "$temporary_volume" "$keep_volume_temporary_volume" "$unrelated_volume" "$wrong_owner_volume" "$symlink_volume" >/dev/null 2>&1 || true
  docker image rm "$driver_image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker info >/dev/null
docker build --quiet --tag "$driver_image" --build-arg "BASE_IMAGE=$image" --file - . <<'EOF' >/dev/null
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY agent/prepare-agent-tmp.sh /usr/local/bin/prepare-agent-tmp
RUN chmod 0755 /usr/local/bin/prepare-agent-tmp
EOF
docker volume create --label dev.dim.role=agent-tmp "$temporary_volume" >/dev/null
docker volume create --label dev.dim.role=agent-tmp "$keep_volume_temporary_volume" >/dev/null
docker volume create --label dev.dim.role=unrelated "$unrelated_volume" >/dev/null
docker volume create --label dev.dim.role=agent-tmp "$wrong_owner_volume" >/dev/null
docker volume create --label dev.dim.role=agent-tmp "$symlink_volume" >/dev/null

docker run --rm --network none --read-only --user 0:0 \
  --env DIM_AGENT_UID=1000 --env DIM_AGENT_GID=1000 \
  --env DIM_AGENT_TMPDIR=/mnt/opencode-tmp \
  --mount "type=volume,src=$temporary_volume,dst=/mnt/opencode-tmp" \
  "$driver_image" /usr/local/bin/prepare-agent-tmp

docker run --detach --name "$agent_one" --user 1000:1000 \
  --env TMPDIR=/mnt/opencode-tmp \
  --mount "type=volume,src=$temporary_volume,dst=/mnt/opencode-tmp" \
  "$driver_image" sh -c 'test "$TMPDIR" != /tmp && test "$(id -u)" = 1000 && printf persistent >"$TMPDIR/restart-marker" && sleep infinity' >/dev/null
test "$(docker exec "$agent_one" stat -c %u:%g:%a /mnt/opencode-tmp)" = 1000:1000:700
docker rm --force "$agent_one" >/dev/null

docker run --detach --name "$agent_two" --user 1000:1000 \
  --env TMPDIR=/mnt/opencode-tmp \
  --mount "type=volume,src=$temporary_volume,dst=/mnt/opencode-tmp" \
  "$driver_image" sh -c 'test "$(cat "$TMPDIR/restart-marker")" = persistent && printf recreated >"$TMPDIR/recreated-marker" && sleep infinity' >/dev/null
actual_tmpdir="$(docker exec "$agent_two" printenv TMPDIR)"
test "$actual_tmpdir" = /mnt/opencode-tmp
test "${actual_tmpdir#/tmp}" = "$actual_tmpdir"
test "$(docker exec "$agent_two" cat /mnt/opencode-tmp/recreated-marker)" = recreated
docker rm --force "$agent_two" >/dev/null

docker run --rm --mount "type=volume,src=$wrong_owner_volume,dst=/mnt/opencode-tmp" \
  "$driver_image" sh -c 'printf foreign >/mnt/opencode-tmp/foreign'
if docker run --rm --network none --read-only --user 0:0 \
  --env DIM_AGENT_UID=1000 --env DIM_AGENT_GID=1000 \
  --env DIM_AGENT_TMPDIR=/mnt/opencode-tmp \
  --mount "type=volume,src=$wrong_owner_volume,dst=/mnt/opencode-tmp" \
  "$driver_image" /usr/local/bin/prepare-agent-tmp; then
  echo "wrong-owner populated temporary volume was accepted" >&2
  exit 1
fi

docker run --rm --mount "type=volume,src=$symlink_volume,dst=/fixture" \
  "$driver_image" sh -c 'mkdir -p /fixture/target && ln -s target /fixture/link'
if docker run --rm --network none --read-only --user 0:0 \
  --env DIM_AGENT_UID=1000 --env DIM_AGENT_GID=1000 \
  --env DIM_AGENT_TMPDIR=/fixture/link \
  --mount "type=volume,src=$symlink_volume,dst=/fixture" \
  "$driver_image" /usr/local/bin/prepare-agent-tmp; then
  echo "symlinked temporary root was accepted" >&2
  exit 1
fi

discard_temporary_volume() {
  discard_mode="$1"
  volume="$2"
  test "$(docker volume inspect --format '{{ index .Labels "dev.dim.role" }}' "$volume")" = agent-tmp
  printf '%s temporary volume before discard: %s\n' "$discard_mode" "$volume"
  docker volume rm "$volume" >/dev/null
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    echo "$discard_mode retained temporary volume after discard: $volume" >&2
    exit 1
  fi
  printf '%s temporary volume after discard: removed\n' "$discard_mode"
}

discard_temporary_volume ordinary "$temporary_volume"
discard_temporary_volume keep-volume "$keep_volume_temporary_volume"
test "$(docker volume inspect --format '{{ index .Labels "dev.dim.role" }}' "$unrelated_volume")" = unrelated

printf 'agent containers: %s %s\n' "$agent_one" "$agent_two"
printf 'agent TMPDIR: %s\n' "$actual_tmpdir"
printf 'unrelated volume retained: %s\n' "$unrelated_volume"
printf 'denied volumes: %s symlink:%s/link\n' "$wrong_owner_volume" "$symlink_volume"
printf 'agent-temporary-volume-smoke-ok\n'
