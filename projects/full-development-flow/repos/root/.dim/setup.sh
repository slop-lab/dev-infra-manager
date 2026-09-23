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
jq '{services:{agent:{extra_hosts:[.hostAliases | to_entries[] | .key as $host | .value[] | "\($host)=\(.)"]}}}' \
  "$DIM_PROJECT_MANIFEST" >"$compose_host_aliases"

export GIT_AUTHOR_NAME="$git_name"
export GIT_AUTHOR_EMAIL="$git_email"
export GIT_COMMITTER_NAME="$git_name"
export GIT_COMMITTER_EMAIL="$git_email"
export DIM_WORKSPACE_UID DIM_WORKSPACE_GID

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
    if [ "$attempt" -eq 30 ]; then
      cat "$proxy_dir/agent.log" >&2
      exit 1
    fi
    sleep 1
  done
fi

DIM_DEVELOPMENT_GATEWAY_PORT="$(dim-development-service gateway-port)"
export DIM_DEVELOPMENT_GATEWAY_PORT
dim-controller-proxy ensure external-url \
  --listen /tmp/dim-development-url/controller.sock \
  --ingress https-ts \
  --bind-containers-json '["agent"]' \
  --bind-protocol http \
  --bind-port "$DIM_DEVELOPMENT_GATEWAY_PORT" \
  --directory-mode 0755 \
  --socket-mode 0666

docker compose \
  --file .dim/docker-compose.yml --file "$compose_host_aliases" "$@" \
  up --detach --build --force-recreate --wait --wait-timeout 60
docker compose \
  --file .dim/docker-compose.yml exec --no-TTY agent \
  chown -R "$DIM_WORKSPACE_UID:$DIM_WORKSPACE_GID" /home/dim-agent
