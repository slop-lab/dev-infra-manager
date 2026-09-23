#!/usr/bin/env sh
set -eu

sh .dim/materialize-app.sh

git_name="$(dim-host-input builtin.git-author name)"
git_email="$(dim-host-input builtin.git-author email)"
DIM_WORKSPACE_UID="$(stat -c %u "$DIM_WORKSPACE_DATA")"
DIM_WORKSPACE_GID="$(stat -c %g "$DIM_WORKSPACE_DATA")"
test "$DIM_WORKSPACE_UID" -ne 0 && test "$DIM_WORKSPACE_GID" -ne 0 || {
  echo "two-repository requires a non-root workspace owner" >&2
  exit 1
}

compose_host_aliases=/tmp/dim-two-repository-compose-host-aliases.json
jq -e '.hostAliases | type == "object"' "$DIM_PROJECT_MANIFEST" >/dev/null
jq '{services:{app:{extra_hosts:[.hostAliases | to_entries[] | .key as $host | .value[] | "\($host)=\(.)"]}}}' \
  "$DIM_PROJECT_MANIFEST" >"$compose_host_aliases"

export GIT_AUTHOR_NAME="$git_name"
export GIT_AUTHOR_EMAIL="$git_email"
export GIT_COMMITTER_NAME="$git_name"
export GIT_COMMITTER_EMAIL="$git_email"
export DIM_WORKSPACE_UID DIM_WORKSPACE_GID

docker compose \
  --file .dim/docker-compose.yml --file "$compose_host_aliases" \
  up --detach --build app
