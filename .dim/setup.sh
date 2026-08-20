#!/usr/bin/env sh
set -eu

if [ -n "${DIM_PROJECT_MANIFEST:-}" ]; then
  test -r "$DIM_PROJECT_MANIFEST"
  test -n "${DIM_GIT_BASE_URL:-}"
  test "$(jq -r '.gitBaseUrl' "$DIM_PROJECT_MANIFEST")" = "$DIM_GIT_BASE_URL"
  test "$(jq -r '.root.path' "$DIM_PROJECT_MANIFEST")" = "${DIM_PROJECT_ROOT:-$PWD}"
fi

compose_host_aliases=/tmp/dim-project-compose-host-aliases.json
jq -e '.hostAliases | type == "object"' "$DIM_PROJECT_MANIFEST" >/dev/null
jq '{services:{agent:{extra_hosts:[.hostAliases | to_entries[] | .key as $host | .value[] | "\($host)=\(.)"]}}}' \
  "$DIM_PROJECT_MANIFEST" > "$compose_host_aliases"

case "${DIM_WORKSPACE_KVM:-}" in
  1)
    test -r /dev/kvm
    test -w /dev/kvm
    ;;
  0)
    test ! -e /dev/kvm
    ;;
  *)
    echo "DIM_WORKSPACE_KVM must be 0 or 1" >&2
    exit 2
    ;;
esac

git_name="$(dim-host-input builtin.git-author name)"
git_email="$(dim-host-input builtin.git-author email)"

export GIT_AUTHOR_NAME="$git_name"
export GIT_AUTHOR_EMAIL="$git_email"
export GIT_COMMITTER_NAME="$git_name"
export GIT_COMMITTER_EMAIL="$git_email"

# Avoid inheriting buildx activity files created by a root lifecycle helper.
export DOCKER_CONFIG=/tmp/dim-workspace-docker-config
mkdir -p "$DOCKER_CONFIG"

compose() {
  docker compose --project-name "dim-${DIM_WORKSPACE_NAME}" \
    --file .dim/docker-compose.yml --file "$compose_host_aliases" "$@"
}
agent_image="dim-${DIM_WORKSPACE_NAME}-agent"
compose build --quiet agent
# An outer workspace stop terminates nested containers without letting their
# daemon preserve a restartable process state. Recreate Project containers on
# every setup while retaining their named data and home volumes.
compose up --detach --force-recreate agent-dind agent
compose exec --no-TTY agent \
  chown -R "$(id -u):$(id -g)" /home/dim-agent
compose exec --no-TTY \
  --user "$(id -u):$(id -g)" \
  --env HOME=/home/dim-agent agent \
  pnpm install --frozen-lockfile
