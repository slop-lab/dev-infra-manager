#!/usr/bin/env sh
set -eu

if [ -n "${DIM_PROJECT_MANIFEST:-}" ]; then
  test -r "$DIM_PROJECT_MANIFEST"
  test -n "${DIM_GIT_BASE_URL:-}"
  test "$(jq -r '.gitBaseUrl' "$DIM_PROJECT_MANIFEST")" = "$DIM_GIT_BASE_URL"
  test "$(jq -r '.root.path' "$DIM_PROJECT_MANIFEST")" = "${DIM_PROJECT_ROOT:-$PWD}"
fi

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

docker compose --project-name "dim-${DIM_WORKSPACE_NAME}" \
  --file .dim/docker-compose.yml up --detach --build agent
docker compose --project-name "dim-${DIM_WORKSPACE_NAME}" \
  --file .dim/docker-compose.yml exec --no-TTY \
  --user "$(id -u):$(id -g)" --env HOME=/tmp/dim-agent-home agent \
  pnpm install --frozen-lockfile
