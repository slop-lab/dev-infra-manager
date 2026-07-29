#!/usr/bin/env sh
set -eu

git_name="$(dim-host-input builtin.git-author name)"
git_email="$(dim-host-input builtin.git-author email)"

jq -n --arg name "$git_name" --arg email "$git_email" -r '
  "GIT_AUTHOR_NAME=" + ($name | @sh),
  "GIT_AUTHOR_EMAIL=" + ($email | @sh),
  "GIT_COMMITTER_NAME=" + ($name | @sh),
  "GIT_COMMITTER_EMAIL=" + ($email | @sh)
' > /tmp/dim-host-inputs.env

docker compose \
  --project-name "$COMPOSE_PROJECT_NAME" \
  --file .dim/docker-compose.yml \
  "$@" \
  up --detach --build
