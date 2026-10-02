#!/usr/bin/env bash
set -euo pipefail

repository_root="$(pwd -P)"
prefix="dim-agent-tmp-production-$PPID-$$"
fixture="$(mktemp -d "/tmp/$prefix.XXXXXX")"
keep_project="$prefix-keep"
ordinary_project="$prefix-ordinary"
collision_project="$prefix-collision"
inverse_collision_project="$prefix-inverse-collision"
foreign_volume="$prefix-foreign"
filesystem_volume="$prefix-filesystem"
wrong_owner_volume="$prefix-wrong-owner"
symlink_volume="$prefix-symlink"
compose_aliases=/tmp/dim-example-compose-host-aliases.json

compose() {
  project="$1"
  shift
  docker compose --project-name "$project" --file "$fixture/.dim/docker-compose.yml" "$@"
}

cleanup() {
  if [ -r "$fixture/proxy.pid" ]; then
    kill "$(cat "$fixture/proxy.pid")" >/dev/null 2>&1 || true
    rm -f /tmp/dim-agent-controller/agent.sock /tmp/dim-agent-controller/agent.log
  fi
  for project in "$keep_project" "$ordinary_project" "$collision_project" "$inverse_collision_project"; do
    compose "$project" down --volumes --remove-orphans >/dev/null 2>&1 || true
  done
  docker volume rm \
    "$foreign_volume" \
    "$filesystem_volume" "$wrong_owner_volume" "$symlink_volume" \
    "${keep_project}_agent-home" "${keep_project}_agent-tmp" \
    "${ordinary_project}_agent-home" "${ordinary_project}_agent-tmp" \
    "${collision_project}_agent-home" "${collision_project}_agent-tmp" \
    "${inverse_collision_project}_agent-home" "${inverse_collision_project}_agent-tmp" \
    >/dev/null 2>&1 || true
  docker image rm "$prefix-agent-dind" >/dev/null 2>&1 || true
  if [ -r "$fixture/compose-host-aliases.backup" ]; then
    cp "$fixture/compose-host-aliases.backup" "$compose_aliases"
  else
    rm -f "$compose_aliases"
  fi
  rm -rf -- "$fixture"
}
trap cleanup EXIT

mkdir -p "$fixture/.dim/agent-dind" "$fixture/bin" "$fixture/data/project/.git"
test ! -e /tmp/dim-agent-controller/agent.sock
test ! -e /tmp/dim-agent-controller/agent.log
if [ -r "$compose_aliases" ]; then
  cp "$compose_aliases" "$fixture/compose-host-aliases.backup"
fi
cp \
  "$repository_root/examples/projects/full-development-flow/repos/root/.dim/setup.sh" \
  "$repository_root/examples/projects/full-development-flow/repos/root/.dim/teardown.sh" \
  "$repository_root/examples/projects/full-development-flow/repos/root/.dim/agent-tmp-volume.sh" \
  "$fixture/.dim/"
cp "$repository_root/examples/projects/full-development-flow/repos/root/.dim/agent/prepare-agent-tmp.sh" \
  "$fixture/.dim/agent-dind/"

cat >"$fixture/.dim/materialize-root.sh" <<'EOF'
#!/usr/bin/env sh
set -eu
test -d "${DIM_WORKSPACE_DATA:?}/project/.git"
EOF

cat >"$fixture/.dim/agent-dind/Dockerfile" <<'EOF'
FROM alpine:3.22
COPY prepare-agent-tmp.sh /usr/local/bin/prepare-agent-tmp
RUN printf '%s\n' '#!/bin/sh' 'exit 0' >/usr/local/bin/dim-agent-dind \
  && chmod 0755 /usr/local/bin/dim-agent-dind /usr/local/bin/prepare-agent-tmp
CMD ["sh", "-c", "sleep infinity"]
EOF

cat >"$fixture/.dim/docker-compose.yml" <<EOF
services:
  agent-dind:
    image: $prefix-agent-dind
    build:
      context: agent-dind
    healthcheck:
      test: ["CMD", "true"]
      interval: 1s
      timeout: 1s
      retries: 10
    volumes:
      - agent-home:/mnt/agent-home
      - agent-tmp:/mnt/agent-tmp
  secure-dind:
    image: alpine:3.22
    profiles: [secure]
    command: ["sh", "-c", "sleep infinity"]
volumes:
  agent-home:
  agent-tmp:
    labels:
      dev.dim.role: agent-tmp
EOF

cat >"$fixture/bin/dim-host-input" <<'EOF'
#!/usr/bin/env sh
case "$2" in
  name) printf 'Temporary Volume Smoke\n' ;;
  email) printf 'tmp-smoke@example.invalid\n' ;;
  *) exit 2 ;;
esac
EOF
cat >"$fixture/bin/dim-development-service" <<'EOF'
#!/usr/bin/env sh
test "$1" = gateway-port
printf '4096\n'
EOF
cat >"$fixture/bin/dim-controller-proxy" <<'EOF'
#!/usr/bin/env sh
set -eu
test "$1" = agent || exit 0
shift
socket=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --listen ]; then
    socket="$2"
    break
  fi
  shift
done
test -n "$socket"
printf '%s\n' "$$" >"${DIM_TMP_FIXTURE:?}/proxy.pid"
exec python3 -c 'import os, socket, sys, time
path = sys.argv[1]
try:
    os.unlink(path)
except FileNotFoundError:
    pass
server = socket.socket(socket.AF_UNIX)
server.bind(path)
server.listen()
while True:
    connection, _ = server.accept()
    connection.recv(4096)
    connection.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
    connection.close()' "$socket"
EOF
chmod 0755 "$fixture/.dim/materialize-root.sh" "$fixture/bin/"*
printf '{"hostAliases":{}}\n' >"$fixture/project.json"
if [ "$(id -u)" = 0 ]; then
  chown -R 1000:1000 "$fixture/data/project"
fi

docker volume create --label dev.dim.role=foreign "$foreign_volume" >/dev/null

run_setup() {
  project="$1"
  (
    cd -- "$fixture"
    env \
      PATH="$fixture/bin:$PATH" \
      DIM_TMP_FIXTURE="$fixture" \
      COMPOSE_PROJECT_NAME="$project" \
      DIM_PROJECT_MANIFEST="$fixture/project.json" \
      DIM_PROJECT_ROOT="$fixture" \
      DIM_WORKSPACE_DATA="$fixture/data" \
      sh .dim/setup.sh
  )
}

run_teardown() {
  project="$1"
  keep="$2"
  (
    cd -- "$fixture"
    env \
      PATH="$fixture/bin:$PATH" \
      COMPOSE_PROJECT_NAME="$project" \
      DIM_WORKSPACE_DISCARD_KEEP_VOLUME="$keep" \
      sh .dim/teardown.sh
  )
}

one_volume() {
  project="$1"
  logical_name="$2"
  volumes="$(docker volume ls --quiet \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.volume=$logical_name")"
  test "$(printf '%s\n' "$volumes" | wc -l)" -eq 1
  printf '%s\n' "$volumes"
}

run_setup "$keep_project"
keep_tmp_volume="$(one_volume "$keep_project" agent-tmp)"
keep_home_volume="$(one_volume "$keep_project" agent-home)"
keep_container="$(compose "$keep_project" ps --all --quiet agent-dind)"
docker exec "$keep_container" sh -c 'printf persistent >/mnt/agent-tmp/restart-marker'
run_setup "$keep_project"
keep_container="$(compose "$keep_project" ps --all --quiet agent-dind)"
test "$(docker exec "$keep_container" cat /mnt/agent-tmp/restart-marker)" = persistent
printf 'temporary metadata: '
docker volume inspect --format \
  'name={{.Name}} driver={{.Driver}} options={{json .Options}} project={{index .Labels "com.docker.compose.project"}} logical={{index .Labels "com.docker.compose.volume"}} role={{index .Labels "dev.dim.role"}}' \
  "$keep_tmp_volume"
compose "$keep_project" stop agent-dind >/dev/null
printf 'keep-volume stopped state before teardown: %s temp=%s home=%s\n' \
  "$(docker inspect --format '{{.State.Status}}' "$keep_container")" "$keep_tmp_volume" "$keep_home_volume"
run_teardown "$keep_project" 1
! docker volume inspect "$keep_tmp_volume" >/dev/null 2>&1
docker volume inspect "$keep_home_volume" >/dev/null
docker volume inspect "$foreign_volume" >/dev/null
printf 'keep-volume stopped cleanup after teardown: temp=removed home=retained foreign=retained\n'

run_setup "$ordinary_project"
ordinary_tmp_volume="$(one_volume "$ordinary_project" agent-tmp)"
ordinary_container="$(compose "$ordinary_project" ps --all --quiet agent-dind)"
compose "$ordinary_project" stop agent-dind >/dev/null
printf 'ordinary stopped state before teardown: %s temp=%s\n' \
  "$(docker inspect --format '{{.State.Status}}' "$ordinary_container")" "$ordinary_tmp_volume"
run_teardown "$ordinary_project" 0
! docker volume inspect "$ordinary_tmp_volume" >/dev/null 2>&1
docker volume inspect "$foreign_volume" >/dev/null
printf 'ordinary stopped cleanup after teardown: temp=removed foreign=retained\n'

docker volume create \
  --label "com.docker.compose.project=$collision_project" \
  --label com.docker.compose.volume=agent-home \
  "${collision_project}_agent-home" >/dev/null
home_mountpoint="$(docker volume inspect --format '{{.Mountpoint}}' "${collision_project}_agent-home")"
docker volume create \
  --driver local \
  --opt type=none \
  --opt o=bind \
  --opt "device=$home_mountpoint" \
  --label "com.docker.compose.project=$collision_project" \
  --label com.docker.compose.volume=agent-tmp \
  --label dev.dim.role=agent-tmp \
  "${collision_project}_agent-tmp" >/dev/null
if run_setup "$collision_project" >"$fixture/collision.out" 2>"$fixture/collision.err"; then
  echo "production setup accepted bind-backed agent temporary storage" >&2
  exit 1
fi
grep -F "agent temporary volume must not use driver options" "$fixture/collision.err" >/dev/null
collision_container="$(compose "$collision_project" ps --all --quiet agent-dind)"
test "$(docker inspect --format '{{.State.Running}}' "$collision_container")" = false
printf 'bind collision metadata: '
docker volume inspect --format 'name={{.Name}} options={{json .Options}} device={{index .Options "device"}}' \
  "${collision_project}_agent-tmp"
printf 'bind collision denied before start: container=%s running=false\n' "$collision_container"

docker volume create \
  --label "com.docker.compose.project=$inverse_collision_project" \
  --label com.docker.compose.volume=agent-tmp \
  --label dev.dim.role=agent-tmp \
  "${inverse_collision_project}_agent-tmp" >/dev/null
docker run --rm \
  --mount "type=volume,src=${inverse_collision_project}_agent-tmp,dst=/mnt/agent-tmp" \
  alpine:3.22 sh -c 'printf inverse-alias-marker >/mnt/agent-tmp/marker'
inverse_tmp_mountpoint="$(docker volume inspect --format '{{.Mountpoint}}' "${inverse_collision_project}_agent-tmp")"
docker volume create \
  --driver local \
  --opt type=none \
  --opt o=bind \
  --opt "device=$inverse_tmp_mountpoint" \
  --label "com.docker.compose.project=$inverse_collision_project" \
  --label com.docker.compose.volume=agent-home \
  "${inverse_collision_project}_agent-home" >/dev/null
printf 'inverse bind metadata before setup: '
docker volume inspect --format 'home={{.Name}} options={{json .Options}} device={{index .Options "device"}}' \
  "${inverse_collision_project}_agent-home"
if run_setup "$inverse_collision_project" >"$fixture/inverse-collision.out" 2>"$fixture/inverse-collision.err"; then
  echo "production setup accepted bind-backed agent home storage" >&2
  exit 1
fi
grep -F "agent home volume must not use driver options" "$fixture/inverse-collision.err" >/dev/null
inverse_collision_container="$(compose "$inverse_collision_project" ps --all --quiet agent-dind)"
test "$(docker inspect --format '{{.State.Running}}' "$inverse_collision_container")" = false
docker volume inspect "${inverse_collision_project}_agent-home" >/dev/null
docker volume inspect "${inverse_collision_project}_agent-tmp" >/dev/null
inverse_marker="$(docker run --rm \
  --mount "type=volume,src=${inverse_collision_project}_agent-tmp,dst=/mnt/agent-tmp" \
  alpine:3.22 cat /mnt/agent-tmp/marker)"
test "$inverse_marker" = inverse-alias-marker
printf 'inverse bind denied before start: container=%s running=false home=retained temp=retained marker=%s\n' \
  "$inverse_collision_container" "$inverse_marker"
if run_teardown "$inverse_collision_project" 1 \
  >"$fixture/inverse-collision-teardown.out" 2>"$fixture/inverse-collision-teardown.err"; then
  echo "production teardown accepted bind-backed agent home storage" >&2
  exit 1
fi
grep -F "agent home volume must not use driver options" "$fixture/inverse-collision-teardown.err" >/dev/null
docker inspect "$inverse_collision_container" >/dev/null
docker volume inspect "${inverse_collision_project}_agent-home" >/dev/null
docker volume inspect "${inverse_collision_project}_agent-tmp" >/dev/null
inverse_marker_after_teardown="$(docker run --rm \
  --mount "type=volume,src=${inverse_collision_project}_agent-tmp,dst=/mnt/agent-tmp" \
  alpine:3.22 cat /mnt/agent-tmp/marker)"
test "$inverse_marker_after_teardown" = inverse-alias-marker
printf 'inverse bind denied during discard: container=retained home=retained temp=retained marker=%s\n' \
  "$inverse_marker_after_teardown"

docker volume create "$filesystem_volume" >/dev/null
docker run --rm --network none --read-only --user 0:0 \
  --env DIM_AGENT_UID=1000 --env DIM_AGENT_GID=1000 \
  --env DIM_AGENT_TMPDIR=/mnt/opencode-tmp \
  --mount "type=volume,src=$filesystem_volume,dst=/mnt/opencode-tmp" \
  "$prefix-agent-dind" /usr/local/bin/prepare-agent-tmp
docker run --rm --user 1000:1000 \
  --env TMPDIR=/mnt/opencode-tmp \
  --mount "type=volume,src=$filesystem_volume,dst=/mnt/opencode-tmp" \
  "$prefix-agent-dind" sh -c 'test "$(printenv TMPDIR)" = /mnt/opencode-tmp && printf persistent >"$TMPDIR/restart-marker"'
actual_tmpdir="$(docker run --rm --user 1000:1000 \
  --env TMPDIR=/mnt/opencode-tmp \
  --mount "type=volume,src=$filesystem_volume,dst=/mnt/opencode-tmp" \
  "$prefix-agent-dind" sh -c 'test "$(cat "$TMPDIR/restart-marker")" = persistent && printenv TMPDIR')"
test "$actual_tmpdir" = /mnt/opencode-tmp

docker volume create "$wrong_owner_volume" >/dev/null
docker run --rm --mount "type=volume,src=$wrong_owner_volume,dst=/mnt/opencode-tmp" \
  alpine:3.22 sh -c 'printf foreign >/mnt/opencode-tmp/foreign'
if docker run --rm --network none --read-only --user 0:0 \
  --env DIM_AGENT_UID=1000 --env DIM_AGENT_GID=1000 \
  --env DIM_AGENT_TMPDIR=/mnt/opencode-tmp \
  --mount "type=volume,src=$wrong_owner_volume,dst=/mnt/opencode-tmp" \
  "$prefix-agent-dind" /usr/local/bin/prepare-agent-tmp; then
  echo "wrong-owner populated temporary root was accepted" >&2
  exit 1
fi

docker volume create "$symlink_volume" >/dev/null
docker run --rm --mount "type=volume,src=$symlink_volume,dst=/fixture" \
  alpine:3.22 sh -c 'mkdir -p /fixture/target && ln -s target /fixture/link'
if docker run --rm --network none --read-only --user 0:0 \
  --env DIM_AGENT_UID=1000 --env DIM_AGENT_GID=1000 \
  --env DIM_AGENT_TMPDIR=/fixture/link \
  --mount "type=volume,src=$symlink_volume,dst=/fixture" \
  "$prefix-agent-dind" /usr/local/bin/prepare-agent-tmp; then
  echo "symlinked temporary root was accepted" >&2
  exit 1
fi

printf 'agent TMPDIR and persistence: %s marker=retained\n' "$actual_tmpdir"
printf 'filesystem denials: wrong-owner=denied symlink=denied\n'
printf 'foreign volume retained: %s\n' "$foreign_volume"
printf 'agent-temporary-volume-smoke-ok\n'
