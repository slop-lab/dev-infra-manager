#!/usr/bin/env sh
set -eu

keep_volumes="${DIM_WORKSPACE_DISCARD_KEEP_VOLUME-0}"
case "$keep_volumes" in
  0|1) ;;
  *)
    echo "DIM_WORKSPACE_DISCARD_KEEP_VOLUME must be 0 or 1" >&2
    exit 2
    ;;
esac

discard_agent_tmp() {
  agent_dind_id="$(docker compose --file .dim/docker-compose.yml ps --quiet agent-dind)"
  test -z "$agent_dind_id" || docker compose \
    --file .dim/docker-compose.yml exec --no-TTY --user root \
    agent-dind dim-agent-dind discard-agent-tmp
}
test "$keep_volumes" = 1 || discard_agent_tmp

set -- down
test "$keep_volumes" = 1 || set -- "$@" --volumes
set -- "$@" --remove-orphans
docker compose --file .dim/docker-compose.yml "$@"
