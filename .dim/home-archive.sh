#!/usr/bin/env sh
set -eu

export DOCKER_CONFIG="/tmp/dim-workspace-docker-config-$(id -u)"
mkdir -p "$DOCKER_CONFIG"
chmod 0700 "$DOCKER_CONFIG"

action="${1:?home archive action is required}"
project="${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}"

case "$action" in
  backup)
    test ! -t 1 || {
      echo "backup writes an archive to stdout; redirect it to a file" >&2
      exit 2
    }
    ;;
  restore)
    test ! -t 0 || {
      echo "restore reads an archive from stdin; redirect a file into it" >&2
      exit 2
    }
    ;;
  *)
    echo "unknown home archive action: $action" >&2
    exit 2
    ;;
esac

one_resource() {
  kind="$1"
  shift
  resources="$(docker "$kind" ls --quiet "$@")"
  test -n "$resources" || {
    echo "no $kind found for the Project agent home" >&2
    exit 1
  }
  test "$(printf '%s\n' "$resources" | wc -l)" -eq 1 || {
    echo "multiple ${kind}s found for the Project agent home" >&2
    exit 1
  }
  printf '%s\n' "$resources"
}

agent_dind_container="$(one_resource container --all \
  --filter "label=com.docker.compose.project=$project" \
  --filter "label=com.docker.compose.service=agent-dind" \
  --filter "label=com.docker.compose.oneoff=False")"
home_volume="$(one_resource volume \
  --filter "label=com.docker.compose.project=$project" \
  --filter "label=com.docker.compose.volume=agent-home")"
archive_image="$(docker inspect --format '{{.Image}}' "$agent_dind_container")"
was_running="$(docker exec "$agent_dind_container" dim-agent-dind inspect \
  --format '{{.State.Running}}' 2>/dev/null || printf false)"

restart_agent() {
  status="$?"
  trap - 0
  if [ "$was_running" = true ]; then
    docker exec "$agent_dind_container" dim-agent-dind start >&2
  fi
  exit "$status"
}
trap restart_agent 0

if [ "$was_running" = true ]; then
  docker exec "$agent_dind_container" dim-agent-dind stop >&2
fi

case "$action" in
  backup)
    docker run --rm --network none --read-only \
      --mount "type=volume,src=$home_volume,dst=/home,readonly" \
      --entrypoint tar "$archive_image" -C /home -czf - .
    ;;
  restore)
    docker run --rm --interactive --network none --read-only \
      --mount "type=volume,src=$home_volume,dst=/home" \
      --entrypoint sh "$archive_image" -c \
      'find /home -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -C /home -xzf -'
    ;;
esac
