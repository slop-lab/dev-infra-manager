#!/usr/bin/env bash
set -euo pipefail

image="${DIM_CONTAINER_TEST_IMAGE:-alpine:3.22}"
prefix="dim-agent-tmp-smoke-$PPID-$$"
driver_image="$prefix-driver"
agent_one="$prefix-agent-one"
agent_two="$prefix-agent-two"
temporary_volume="$prefix-opencode-tmp"
unrelated_volume="$prefix-unrelated"
wrong_owner_volume="$prefix-wrong-owner"
symlink_volume="$prefix-symlink"

cleanup() {
  docker rm --force "$agent_one" "$agent_two" >/dev/null 2>&1 || true
  docker volume rm "$temporary_volume" "$unrelated_volume" "$wrong_owner_volume" "$symlink_volume" >/dev/null 2>&1 || true
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
docker volume create --label dev.dim.role=unrelated "$unrelated_volume" >/dev/null
docker volume create --label dev.dim.role=agent-tmp "$wrong_owner_volume" >/dev/null
docker volume create --label dev.dim.role=agent-tmp "$symlink_volume" >/dev/null

docker run --rm --network none --read-only --user 0:0 \
  --env DIM_AGENT_UID=1000 --env DIM_AGENT_GID=1000 \
  --env DIM_AGENT_TMPDIR=/tmp/opencode \
  --mount "type=volume,src=$temporary_volume,dst=/tmp/opencode" \
  "$driver_image" /usr/local/bin/prepare-agent-tmp

docker run --detach --name "$agent_one" --user 1000:1000 \
  --env TMPDIR=/tmp/opencode \
  --mount "type=volume,src=$temporary_volume,dst=/tmp/opencode" \
  "$driver_image" sh -c 'test "$TMPDIR" != /tmp && test "$(id -u)" = 1000 && printf persistent >"$TMPDIR/restart-marker" && sleep infinity' >/dev/null
test "$(docker exec "$agent_one" stat -c %u:%g:%a /tmp/opencode)" = 1000:1000:700
docker rm --force "$agent_one" >/dev/null

docker run --detach --name "$agent_two" --user 1000:1000 \
  --env TMPDIR=/tmp/opencode \
  --mount "type=volume,src=$temporary_volume,dst=/tmp/opencode" \
  "$driver_image" sh -c 'test "$(cat "$TMPDIR/restart-marker")" = persistent && printf recreated >"$TMPDIR/recreated-marker" && sleep infinity' >/dev/null
test "$(docker exec "$agent_two" cat /tmp/opencode/recreated-marker)" = recreated
docker rm --force "$agent_two" >/dev/null

docker run --rm --mount "type=volume,src=$wrong_owner_volume,dst=/tmp/opencode" \
  "$driver_image" sh -c 'printf foreign >/tmp/opencode/foreign'
if docker run --rm --network none --read-only --user 0:0 \
  --env DIM_AGENT_UID=1000 --env DIM_AGENT_GID=1000 \
  --env DIM_AGENT_TMPDIR=/tmp/opencode \
  --mount "type=volume,src=$wrong_owner_volume,dst=/tmp/opencode" \
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

test "$(docker volume inspect --format '{{ index .Labels "dev.dim.role" }}' "$temporary_volume")" = agent-tmp
docker volume rm "$temporary_volume" >/dev/null
test "$(docker volume inspect --format '{{ index .Labels "dev.dim.role" }}' "$unrelated_volume")" = unrelated

printf 'agent containers: %s %s\n' "$agent_one" "$agent_two"
printf 'temporary volume removed: %s\n' "$temporary_volume"
printf 'unrelated volume retained: %s\n' "$unrelated_volume"
printf 'denied volumes: %s symlink:%s/link\n' "$wrong_owner_volume" "$symlink_volume"
printf 'agent-temporary-volume-smoke-ok\n'
