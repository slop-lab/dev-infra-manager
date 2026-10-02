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
  agent_dind_id="$(docker compose --file .dim/docker-compose.yml ps --all --quiet agent-dind)"
  test -z "$agent_dind_id" || sh .dim/agent-tmp-volume.sh discard "$agent_dind_id"
}
discard_agent_tmp

set -- down
test "$keep_volumes" = 1 || set -- "$@" --volumes
set -- "$@" --remove-orphans
docker compose --file .dim/docker-compose.yml "$@"
