#!/usr/bin/env sh
set -eu

git_name="$(dim-host-input builtin.git-author name)"
git_email="$(dim-host-input builtin.git-author email)"

export GIT_AUTHOR_NAME="$git_name"
export GIT_AUTHOR_EMAIL="$git_email"
export GIT_COMMITTER_NAME="$git_name"
export GIT_COMMITTER_EMAIL="$git_email"

web_url_dir=/tmp/dim-web-url
web_url_socket="$web_url_dir/controller.sock"
if ! curl --fail --silent --unix-socket "$web_url_socket" \
  http://dim-controller/api >/dev/null 2>&1; then
  mkdir -p "$web_url_dir"
  dim-controller-proxy external-url \
    --listen "$web_url_socket" \
    --ingress https-ts \
    --target-containers-json '["agent"]' \
    --target-protocol http \
    --target-port 4096 \
    --directory-mode 0755 \
    --socket-mode 0666 \
    >"$web_url_dir/proxy.log" 2>&1 &
  for attempt in $(seq 1 30); do
    test -S "$web_url_socket" && break
    if [ "$attempt" -eq 30 ]; then
      cat "$web_url_dir/proxy.log" >&2
      exit 1
    fi
    sleep 1
  done
fi

docker compose \
  --file .dim/docker-compose.yml up --detach --build agent
docker compose \
  --file .dim/docker-compose.yml exec --no-TTY agent \
  chown -R "$(id -u):$(id -g)" /home/dim-agent
