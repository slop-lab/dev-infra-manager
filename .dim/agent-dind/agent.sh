#!/bin/sh
set -eu

agent_name="dim-agent"
agent_image="dim-${DIM_WORKSPACE_NAME:?}-agent"
docker_socket=/run/docker.sock

agent_dind() {
  exec env DOCKER_HOST="unix://$docker_socket" docker "$@"
}

case "${1:?private agent action is required}" in
  setup)
    test -r /run/dim/project.json
    test -d /workspace/agent
    workspace_uid="$(stat -c %u /workspace)"
    workspace_gid="$(stat -c %g /workspace)"
    docker_gid="$(stat -c %g "$docker_socket")"
    chown -R "$workspace_uid:$workspace_gid" /mnt/agent-home
    docker build --quiet \
      --build-arg "DIM_UID=$workspace_uid" \
      --build-arg "DIM_GID=$workspace_gid" \
      --tag "$agent_image" /workspace/agent >/dev/null
    docker rm --force "$agent_name" >/dev/null 2>&1 || true
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
      --group-add "$docker_gid" \
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
    host_mappings=/tmp/dim-agent-hosts
    jq -r '.hostAliases | to_entries[] | .key as $host | .value[] | "\($host)=\(.)"' \
      /run/dim/project.json >"$host_mappings"
    while IFS= read -r mapping; do
      test -z "$mapping" || set -- "$@" --add-host "$mapping"
    done <"$host_mappings"
    set -- "$@" "$agent_image" sleep infinity
    docker "$@" >/dev/null
    # A rootful daemon nested inside a user-namespaced workspace can expose
    # extracted setuid files with the workspace root's outer UID. Normalize
    # sudo's trusted files from the daemon's own root boundary before use.
    docker exec --user 0:0 "$agent_name" sh -eu -c '
      chown 0:0 /etc/sudo.conf /etc/sudoers /usr/bin/sudo
      chown -R 0:0 /etc/sudoers.d
      chmod 0440 /etc/sudoers.d/dim-agent
      chmod 4755 /usr/bin/sudo
    '
    docker exec \
      --workdir /workspace "$agent_name" \
      pnpm install --frozen-lockfile
    ;;
  exec)
    shift
    if [ -t 0 ] && [ -t 1 ]; then
      agent_dind exec --interactive --tty "$agent_name" "$@"
    else
      agent_dind exec --interactive "$agent_name" "$@"
    fi
    ;;
  start|stop)
    action="$1"
    agent_dind "$action" "$agent_name"
    ;;
  inspect)
    shift
    agent_dind inspect "$agent_name" "$@"
    ;;
  docker)
    shift
    agent_dind "$@"
    ;;
  *)
    echo "unknown private agent action: $1" >&2
    exit 2
    ;;
esac
