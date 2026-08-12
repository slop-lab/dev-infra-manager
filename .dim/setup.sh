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

# Avoid inheriting buildx activity files created by a root lifecycle helper.
export DOCKER_CONFIG=/tmp/dim-workspace-docker-config
mkdir -p "$DOCKER_CONFIG"

agent_uid="$(id -u)"
agent_gid="$(id -g)"
compose="docker compose --project-name dim-${DIM_WORKSPACE_NAME} --file .dim/docker-compose.yml"
agent_image="dim-${DIM_WORKSPACE_NAME}-agent"
$compose build --quiet agent
# Setup runs as the unprivileged workspace account. This short-lived reviewed
# helper creates only the fixed subtree; the persistent agent stays unprivileged.
docker run --rm --privileged --cgroupns host \
  --mount type=bind,source=/sys/fs/cgroup,target=/sys/fs/cgroup \
  --mount type=bind,source="$PWD/.dim/cgroup-delegation.sh",target=/tmp/cgroup-delegation.sh,readonly \
  "$agent_image" sh /tmp/cgroup-delegation.sh setup "$agent_uid" "$agent_gid"

$compose up --detach agent
$compose exec --no-TTY \
  --user "$(id -u):$(id -g)" --env HOME=/tmp/dim-agent-home agent \
  pnpm install --frozen-lockfile
