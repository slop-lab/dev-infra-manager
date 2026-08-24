#!/usr/bin/env bash
set -euo pipefail

image="${DIM_CONTAINER_TEST_IMAGE:-alpine:3.22}"
prefix="dim-agent-docker-$PPID-$$"
container="$prefix-server"
network="$prefix-network"
volume="$prefix-volume"
build_tag="$prefix-build"

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker image rm "$build_tag" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker info >/dev/null
docker info --format '{{json .SecurityOptions}}' | grep -q 'rootless'

docker build --quiet --tag "$build_tag" - <<'EOF' >/dev/null
FROM alpine:3.22
RUN printf '#!/bin/sh\necho agent-docker-build-ok\n' > /usr/local/bin/probe \
  && chmod 0755 /usr/local/bin/probe
CMD ["probe"]
EOF
test "$(docker run --rm "$build_tag")" = "agent-docker-build-ok"

docker volume create "$volume" >/dev/null
docker run --rm --volume "$volume:/data" "$image" sh -c 'printf persisted > /data/probe'
docker run --rm --volume "$volume:/data" "$image" \
  sh -c 'test "$(cat /data/probe)" = persisted'

docker run --rm "$image" sh -c \
  'wget -qO- https://example.com >/dev/null'

docker network create "$network" >/dev/null
docker run --detach --name "$container" --network "$network" "$image" \
  sh -c 'while true; do nc -l -p 8080 -e echo peer-ok; done' >/dev/null
docker run --rm --network "$network" "$image" sh -c "
  for _ in 1 2 3 4 5; do
    result=\$(nc -w 2 '$container' 8080 2>/dev/null || true)
    test \"\$result\" = peer-ok && exit 0
    sleep 1
  done
  exit 1
"

echo "agent-docker-smoke-ok"
