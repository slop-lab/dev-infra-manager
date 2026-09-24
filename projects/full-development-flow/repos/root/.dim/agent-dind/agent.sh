#!/bin/sh
set -eu

agent_name="dim-agent"
agent_image="dim-example-agent"
documentation_name="dim-documentation-preview"
docker_socket="${DOCKER_HOST#unix://}"

case "${1:?private agent action is required}" in
  setup)
    docker build --quiet --tag "$agent_image" \
      --build-arg "DIM_WORKSPACE_UID=$DIM_WORKSPACE_UID" \
      --build-arg "DIM_WORKSPACE_GID=$DIM_WORKSPACE_GID" \
      /run/dim/project-root/.dim/agent >/dev/null
    docker rm --force "$agent_name" >/dev/null 2>&1 || true
    set -- run --detach --name "$agent_name" --restart unless-stopped \
      --publish "$DIM_DEVELOPMENT_GATEWAY_PORT:$DIM_DEVELOPMENT_GATEWAY_PORT" \
      --label dev.dim.role=agent \
      --add-host secret:host-gateway \
      --env DOCKER_HOST=unix:///run/dim-agent-dind/docker.sock \
      --env HOME=/home/dim-agent \
      --env PATH=/home/dim-agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      --env DIM_CONTROLLER_SOCKET=/run/dim/controller-proxy/agent.sock \
      --env DIM_DEVELOPMENT_URL_SOCKET=/run/dim/development-url/controller.sock \
      --env 'DIM_EXTERNAL_URL_CONTAINERS_JSON=["agent-dind","dim-agent"]' \
      --mount type=bind,src=/run/dim/controller-proxy,dst=/run/dim/controller-proxy,readonly \
      --mount type=bind,src=/run/dim/development-url,dst=/run/dim/development-url,readonly \
      --mount type=bind,src=/usr/local/lib/dim/controller-proxy,dst=/usr/local/lib/dim/controller-proxy,readonly \
      --env "DIM_GIT_USERNAME=$DIM_GIT_USERNAME" \
      --env "DIM_GIT_TOKEN=$DIM_GIT_TOKEN" \
      --env "GIT_AUTHOR_NAME=$GIT_AUTHOR_NAME" \
      --env "GIT_AUTHOR_EMAIL=$GIT_AUTHOR_EMAIL" \
      --env "GIT_COMMITTER_NAME=$GIT_COMMITTER_NAME" \
      --env "GIT_COMMITTER_EMAIL=$GIT_COMMITTER_EMAIL" \
      --env GIT_TERMINAL_PROMPT=0 \
      --env GIT_CONFIG_COUNT=3 \
      --env GIT_CONFIG_KEY_0=credential.helper \
      --env 'GIT_CONFIG_VALUE_0=!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f' \
      --env GIT_CONFIG_KEY_1=safe.directory \
      --env GIT_CONFIG_VALUE_1=/workspace \
      --env GIT_CONFIG_KEY_2=safe.directory \
      --env 'GIT_CONFIG_VALUE_2=/workspace/*' \
      --mount type=bind,src=/workspace,dst=/workspace \
      --mount type=bind,src=/mnt/agent-home,dst=/home/dim-agent \
      --mount type=bind,src=/mnt/workspace-shared-dind,dst=/mnt/workspace-shared-dind \
      --mount "type=bind,src=$docker_socket,dst=/run/dim-agent-dind/docker.sock" \
      --workdir /workspace
    jq -r '.hostAliases | to_entries[] | .key as $host | .value[] | "\($host)=\(.)"' \
      /run/dim/project.json >/tmp/dim-agent-hosts
    while IFS= read -r mapping; do
      test -z "$mapping" || set -- "$@" --add-host "$mapping"
    done </tmp/dim-agent-hosts
    docker "$@" "$agent_image" >/dev/null
    for attempt in $(seq 1 60); do
      docker exec "$agent_name" nc -z 127.0.0.1 22 >/dev/null 2>&1 && exit 0
      test "$attempt" -lt 60 || { docker logs "$agent_name" >&2; exit 1; }
      sleep 1
    done
    ;;
  documentation)
    docker rm --force "$documentation_name" >/dev/null 2>&1 || true
    docker run --detach --name "$documentation_name" --restart unless-stopped \
      alpine:3.22 sh -c "printf 'documentation-ready\n' >/tmp/ready && sleep infinity" >/dev/null
    ;;
  exec)
    shift
    if [ -t 0 ] && [ -t 1 ]; then
      exec docker exec --interactive --tty \
        --user "$DIM_WORKSPACE_UID:$DIM_WORKSPACE_GID" --env HOME=/home/dim-agent \
        "$agent_name" "$@"
    fi
    exec docker exec --interactive \
      --user "$DIM_WORKSPACE_UID:$DIM_WORKSPACE_GID" --env HOME=/home/dim-agent \
      "$agent_name" "$@"
    ;;
  start|stop)
    docker "$1" "$agent_name"
    ;;
  inspect)
    shift
    exec docker inspect "$agent_name" "$@"
    ;;
  docker)
    shift
    exec docker "$@"
    ;;
  *)
    echo "unknown private agent action: $1" >&2
    exit 2
    ;;
esac
