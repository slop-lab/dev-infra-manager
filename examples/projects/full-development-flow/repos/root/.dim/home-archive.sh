#!/usr/bin/env sh
set -eu

action="${1:?home archive action is required}"
project="dim-${DIM_WORKSPACE_NAME:?DIM_WORKSPACE_NAME is required}"

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

agent_container="$(one_resource container --all \
  --filter "label=com.docker.compose.project=$project" \
  --filter "label=com.docker.compose.service=agent" \
  --filter "label=com.docker.compose.oneoff=False")"
home_volume="$(one_resource volume \
  --filter "label=com.docker.compose.project=$project" \
  --filter "label=com.docker.compose.volume=agent-home")"
agent_image="$(docker inspect --format '{{.Image}}' "$agent_container")"
was_running="$(docker inspect --format '{{.State.Running}}' "$agent_container")"

restart_agent() {
  status="$?"
  trap - 0
  if [ "$was_running" = true ]; then
    docker start "$agent_container" >&2
  fi
  exit "$status"
}
trap restart_agent 0

if [ "$was_running" = true ]; then
  docker stop "$agent_container" >&2
fi

case "$action" in
  backup)
    docker run --rm --network none --read-only \
      --mount "type=volume,src=$home_volume,dst=/home,readonly" \
      --entrypoint tar "$agent_image" -C /home -czf - .
    ;;
  restore)
    docker run --rm --interactive --network none --read-only \
      --mount "type=volume,src=$home_volume,dst=/home" \
      --entrypoint sh "$agent_image" -c \
      'find /home -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -C /home -xzf -'
    ;;
esac
