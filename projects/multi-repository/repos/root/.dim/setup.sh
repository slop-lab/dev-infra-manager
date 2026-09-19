#!/usr/bin/env sh
set -eu

git_name="$(dim-host-input builtin.git-author name)"
git_email="$(dim-host-input builtin.git-author email)"

export GIT_AUTHOR_NAME="$git_name"
export GIT_AUTHOR_EMAIL="$git_email"
export GIT_COMMITTER_NAME="$git_name"
export GIT_COMMITTER_EMAIL="$git_email"

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
  --file .dim/docker-compose.yml up --detach --build agent
docker compose \
  --file .dim/docker-compose.yml exec --no-TTY agent \
  chown -R "$(id -u):$(id -g)" /home/dim-agent
