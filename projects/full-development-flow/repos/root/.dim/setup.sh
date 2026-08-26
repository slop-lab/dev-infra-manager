#!/usr/bin/env sh
set -eu

git_name="$(dim-host-input builtin.git-author name)"
git_email="$(dim-host-input builtin.git-author email)"

export GIT_AUTHOR_NAME="$git_name"
export GIT_AUTHOR_EMAIL="$git_email"
export GIT_COMMITTER_NAME="$git_name"
export GIT_COMMITTER_EMAIL="$git_email"

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

docker compose \
  --file .dim/docker-compose.yml "$@" up --detach --build --force-recreate
docker compose \
  --file .dim/docker-compose.yml exec --no-TTY agent \
  chown -R "$(id -u):$(id -g)" /home/dim-agent
