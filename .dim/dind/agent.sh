#!/bin/sh
set -eu

agent_name="dim-private-agent"
agent_image="dim-${DIM_WORKSPACE_NAME:?}-agent"
docker_socket=/run/user/1000/docker.sock

private_docker() {
  exec su-exec rootless env HOME=/home/rootless XDG_RUNTIME_DIR=/run/user/1000 \
    DOCKER_HOST="unix://$docker_socket" docker "$@"
}

case "${1:?private agent action is required}" in
  setup)
    test -r /run/dim/project.json
    test -d /workspace/agent
    su-exec rootless env HOME=/home/rootless XDG_RUNTIME_DIR=/run/user/1000 \
      DOCKER_HOST="unix://$docker_socket" docker build --quiet \
      --tag "$agent_image" /workspace/agent >/dev/null
    su-exec rootless env HOME=/home/rootless XDG_RUNTIME_DIR=/run/user/1000 \
      DOCKER_HOST="unix://$docker_socket" docker rm --force "$agent_name" >/dev/null 2>&1 || true
    set -- run --detach --name "$agent_name" --restart unless-stopped \
      --label dev.dim.role=agent \
      --env DOCKER_HOST=unix:///run/docker.sock \
      --env HOME=/home/dim-agent \
      --env "DIM_GIT_USERNAME=$DIM_GIT_USERNAME" \
      --env "DIM_GIT_TOKEN=$DIM_GIT_TOKEN" \
      --env "GIT_AUTHOR_NAME=$GIT_AUTHOR_NAME" \
      --env "GIT_AUTHOR_EMAIL=$GIT_AUTHOR_EMAIL" \
      --env "GIT_COMMITTER_NAME=$GIT_COMMITTER_NAME" \
      --env "GIT_COMMITTER_EMAIL=$GIT_COMMITTER_EMAIL" \
      --env GIT_CONFIG_COUNT=2 \
      --env GIT_CONFIG_KEY_0=credential.helper \
      --env 'GIT_CONFIG_VALUE_0=!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f' \
      --env GIT_CONFIG_KEY_1=safe.directory \
      --env GIT_CONFIG_VALUE_1=/workspace \
      --mount type=bind,src=/workspace,dst=/workspace \
      --mount type=bind,src=/mnt/agent-home,dst=/home/dim-agent \
      --mount type=bind,src=/mnt/workspace-shared-dind,dst=/mnt/workspace-shared-dind \
      --mount "type=bind,src=$docker_socket,dst=/run/docker.sock" \
      --workdir /workspace
    host_mappings=/tmp/dim-private-agent-hosts
    jq -r '.hostAliases | to_entries[] | .key as $host | .value[] | "\($host)=\(.)"' \
      /run/dim/project.json >"$host_mappings"
    while IFS= read -r mapping; do
      test -z "$mapping" || set -- "$@" --add-host "$mapping"
    done <"$host_mappings"
    set -- "$@" "$agent_image" sleep infinity
    su-exec rootless env HOME=/home/rootless XDG_RUNTIME_DIR=/run/user/1000 \
      DOCKER_HOST="unix://$docker_socket" docker "$@" >/dev/null
    su-exec rootless env HOME=/home/rootless XDG_RUNTIME_DIR=/run/user/1000 \
      DOCKER_HOST="unix://$docker_socket" docker exec \
      --workdir /workspace "$agent_name" \
      pnpm install --frozen-lockfile
    ;;
  exec)
    shift
    private_docker exec --interactive "$agent_name" "$@"
    ;;
  start|stop)
    action="$1"
    private_docker "$action" "$agent_name"
    ;;
  inspect)
    shift
    private_docker inspect "$agent_name" "$@"
    ;;
  docker)
    shift
    private_docker "$@"
    ;;
  *)
    echo "unknown private agent action: $1" >&2
    exit 2
    ;;
esac
