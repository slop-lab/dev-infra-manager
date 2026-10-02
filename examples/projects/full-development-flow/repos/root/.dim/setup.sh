#!/usr/bin/env sh
set -eu

sh .dim/materialize-root.sh

git_name="$(dim-host-input builtin.git-author name)"
git_email="$(dim-host-input builtin.git-author email)"
DIM_WORKSPACE_UID="$(stat -c %u "$DIM_WORKSPACE_DATA/project")"
DIM_WORKSPACE_GID="$(stat -c %g "$DIM_WORKSPACE_DATA/project")"
test "$DIM_WORKSPACE_UID" -ne 0 && test "$DIM_WORKSPACE_GID" -ne 0 || {
  echo "full-development-flow requires a non-root workspace owner" >&2
  exit 1
}

compose_host_aliases=/tmp/dim-example-compose-host-aliases.json
jq -e '.hostAliases | type == "object"' "$DIM_PROJECT_MANIFEST" >/dev/null
jq '{services:{"agent-dind":{extra_hosts:[.hostAliases | to_entries[] | .key as $host | .value[] | "\($host)=\(.)"]}}}' \
  "$DIM_PROJECT_MANIFEST" >"$compose_host_aliases"

export GIT_AUTHOR_NAME="$git_name"
export GIT_AUTHOR_EMAIL="$git_email"
export GIT_COMMITTER_NAME="$git_name"
export GIT_COMMITTER_EMAIL="$git_email"
export DIM_WORKSPACE_UID DIM_WORKSPACE_GID
export COMPOSE_BAKE=false

proxy_dir=/tmp/dim-agent-controller
proxy_socket="$proxy_dir/agent.sock"
if ! curl --fail --silent --unix-socket "$proxy_socket" \
  http://dim-controller/api >/dev/null 2>&1; then
  mkdir -p "$proxy_dir"
  dim-controller-proxy agent \
    --listen "$proxy_socket" \
    --directory-mode 0755 \
    --socket-mode 0666 \
    --allow-workspace-restart \
    >"$proxy_dir/agent.log" 2>&1 &
  for attempt in $(seq 1 30); do
    test -S "$proxy_socket" && break
    test "$attempt" -lt 30 || { cat "$proxy_dir/agent.log" >&2; exit 1; }
    sleep 1
  done
fi

DIM_DEVELOPMENT_GATEWAY_PORT="$(dim-development-service gateway-port)"
export DIM_DEVELOPMENT_GATEWAY_PORT
opencode_workspace_slug="$(dim-development-service workspace-subdomain --workspace "${DIM_WORKSPACE_NAME:?}" --service opencode)"
dim-controller-proxy ensure external-url \
  --listen /tmp/dim-development-url/controller.sock \
  --ingress https-ts \
  --bind-containers-json '["agent-dind","dim-agent"]' \
  --bind-protocol http \
  --bind-port "$DIM_DEVELOPMENT_GATEWAY_PORT" \
  --directory-mode 0755 \
  --socket-mode 0666
dim-controller-proxy ensure external-url \
  --listen /tmp/dim-development-url/opencode.sock \
  --ingress https-ts \
  --bind-containers-json '["agent-dind","dim-agent"]' \
  --bind-protocol http \
  --bind-port "$DIM_DEVELOPMENT_GATEWAY_PORT" \
  --bind-service-subdomain "opencode-web=$opencode_workspace_slug" \
  --directory-mode 0755 \
  --socket-mode 0666

docker compose \
  --file .dim/docker-compose.yml --file "$compose_host_aliases" \
  build --quiet agent-dind
docker compose \
  --file .dim/docker-compose.yml --file "$compose_host_aliases" \
  create --force-recreate agent-dind
agent_dind_id="$(docker compose \
  --file .dim/docker-compose.yml --file "$compose_host_aliases" \
  ps --all --quiet agent-dind)"
test -n "$agent_dind_id"
sh .dim/agent-tmp-volume.sh prepare "$agent_dind_id"
docker compose \
  --file .dim/docker-compose.yml --file "$compose_host_aliases" \
  up --detach --wait --wait-timeout 60 agent-dind
docker compose \
  --file .dim/docker-compose.yml --file "$compose_host_aliases" \
  exec --no-TTY --user root agent-dind dim-agent-dind setup

case ",${COMPOSE_PROFILES:-}," in
  *,secure,*)
    docker compose \
      --file .dim/docker-compose.yml --file "$compose_host_aliases" \
      --profile secure build --quiet secure-dind
    docker compose \
      --file .dim/docker-compose.yml --file "$compose_host_aliases" \
      --profile secure up --detach --force-recreate --wait --wait-timeout 60 secure-dind
    ;;
  *)
    docker compose \
      --file .dim/docker-compose.yml --file "$compose_host_aliases" \
      --profile secure stop secure-dind
    ;;
esac

case ",${COMPOSE_PROFILES:-}," in
  *,documentation,*)
    docker compose \
      --file .dim/docker-compose.yml --file "$compose_host_aliases" \
      exec --no-TTY --user root agent-dind dim-agent-dind documentation
    ;;
  *)
    docker compose \
      --file .dim/docker-compose.yml --file "$compose_host_aliases" \
      exec --no-TTY --user root agent-dind dim-agent-dind clear-documentation
    ;;
esac
