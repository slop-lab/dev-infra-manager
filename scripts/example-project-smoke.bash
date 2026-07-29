#!/usr/bin/env bash
set -euo pipefail

# Executes examples/multi-repo-project/README.md, command for command,
# against a real Docker daemon and the environment's managed Gitea. Update
# that doc (and the repository skeletons under
# examples/multi-repo-project/repos/) alongside this script if any of them
# change; it exists specifically so the example cannot silently drift from
# what actually works.
#
# DIM isn't installed from the published package here (today's changes
# aren't released yet): it's built locally, packed, and installed through
# the installer facade (`dim install-cli`) against a disposable local npm
# registry, matching how a real user would install it once released.
#
# Requires: Docker, a reachable `dim-gitea` container (this repository's own
# dev environment provides one; see docs/repo-workspaces.md), and network
# access to install the local registry package itself.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
# shellcheck source=lib/local-npm-registry.bash
source "$script_dir/lib/local-npm-registry.bash"

suffix="$PPID-$$"
project_name="example-$suffix"
workspace_name="example-dev-$suffix"
work_dir="$(mktemp -d /tmp/dim-example-project.XXXXXX)"
state_root="$work_dir/state"
source_root="$work_dir/source"
install_prefix="$work_dir/install"
dim_bin="$install_prefix/bin/dim"

export DIM_STATE_ROOT="$state_root"
export DIM_CONFIG_PATH="$work_dir/config/dim.json"
# Isolate where install-cli puts the versioned DIM CLI too, not just state/
# config: package.json's version doesn't change between local test runs, and
# npm treats an already-installed version as up to date even when a fresh
# local registry republished different content under that same version.
export DIM_DATA_HOME="$work_dir/data"
export GIT_CONFIG_GLOBAL="$work_dir/host.gitconfig"
git config --file "$GIT_CONFIG_GLOBAL" user.name "Example Host Developer"
git config --file "$GIT_CONFIG_GLOBAL" user.email "host-developer@dim.invalid"
bash "$script_dir/configure-user-backend.bash" runc

dim() { "$dim_bin" "$@"; }

cleanup() {
  if [[ -f "$state_root/workspaces/$workspace_name.json" ]]; then
    dim discard "$workspace_name" --yes >/dev/null 2>&1 || true
  fi
  if docker container inspect dim-gitea >/dev/null 2>&1; then
    local credentials admin_username admin_password
    credentials="$(docker exec dim-gitea cat /data/dim/credentials.json 2>/dev/null || true)"
    if [[ -n "$credentials" ]]; then
      admin_username="$(printf '%s' "$credentials" | jq -r .adminUsername)"
      admin_password="$(printf '%s' "$credentials" | jq -r .adminPassword)"
      curl --fail --silent --show-error \
        --user "$admin_username:$admin_password" \
        --request DELETE \
        "http://127.0.0.1:${DIM_GITEA_PORT:-3300}/api/v1/orgs/dim-$project_name" \
        >/dev/null 2>&1 || true
    fi
  fi
  dim_stop_local_npm_registry
  rm -rf "$work_dir"
}
trap cleanup EXIT

cd "$repo_root"
echo "[example-project] build workspace packages"
pnpm run workspace:build >/dev/null

echo "[example-project] pack tarballs"
npm pack packages/core/dist --pack-destination "$work_dir" --silent >/dev/null
npm pack packages/external-url-contracts/dist --pack-destination "$work_dir" --silent >/dev/null
npm pack packages/provider-dns-cloudflare/dist --pack-destination "$work_dir" --silent >/dev/null
npm pack packages/ingress-external-url-caddy/dist --pack-destination "$work_dir" --silent >/dev/null
npm pack packages/dim-cli/dist --pack-destination "$work_dir" --silent >/dev/null
npm pack packages/install/dist --pack-destination "$work_dir" --silent >/dev/null

echo "[example-project] 1. install DIM through the installer facade"
dim_start_local_npm_registry "$work_dir"
dim_publish_to_local_registry \
  "$work_dir"/*dev-infra-manager-core*.tgz \
  "$work_dir"/*external-url-contracts*.tgz \
  "$work_dir"/*provider-dns-cloudflare*.tgz \
  "$work_dir"/*ingress-external-url-caddy*.tgz \
  "$work_dir"/*dim-cli*.tgz \
  "$work_dir"/*install-dim*.tgz
mkdir -p "$install_prefix"
npm install --global --prefix "$install_prefix" "$work_dir"/*install-dim*.tgz --silent >/dev/null
"$dim_bin" install-cli --no-local-bin >/dev/null
test -x "$dim_bin"
dim doctor >/dev/null

echo "[example-project] 2. create the example repositories"
bash "$repo_root/examples/multi-repo-project/create-repositories.bash" \
  "$source_root" >/dev/null

root_repo="$source_root/root"

echo "[example-project] 3. register the Project and its repositories"
DIM_BIN="$dim_bin" bash \
  "$repo_root/examples/multi-repo-project/register-project.bash" \
  "$project_name" "$source_root" >/dev/null

# The whole point of --protect at create time: confirm the root branch is
# actually protected, not just reported as such (repo protect "succeeds"
# even with nothing configured, per projectRegistry.ts). Re-pushing the
# identical ref would be a silent no-op either way, so make a real commit.
echo "unauthorized change" >> "$root_repo/.dim/entrypoint.sh"
git -C "$root_repo" commit -am "attempted direct push" >/dev/null
if dim x git -C "$root_repo" push "$(dim repo url "$project_name" root)" main >/dev/null 2>&1; then
  echo "protected branch unexpectedly accepted a direct push" >&2
  exit 1
fi

# Registration must be sufficient: the seed checkouts don't need to survive
# for workspace creation to clone the root repository on its own.
rm -rf "$source_root"

echo "[example-project] 4. create the workspace (a real container)"
dim create "$project_name" "$workspace_name" >/dev/null

echo "[example-project] 5. confirm it's real"
# The workspace's actual container name is an implementation detail of
# `dim`, not something to guess: read it back from `dim show --json` rather
# than assuming a `dim-ws-<name>`-shaped prefix.
workspace_json="$(dim show "$workspace_name" --json)"
test "$(jq -r .phase <<<"$workspace_json")" = "ready"
test "$(jq -r .runtimeBackend <<<"$workspace_json")" = "runc"
test "$(jq -r '.profiles | length' <<<"$workspace_json")" = "0"
container_name="$(jq -r .containerName <<<"$workspace_json")"
docker ps --filter "name=$container_name" --format '{{.Names}}' | grep -qx "$container_name"
dim exec "$workspace_name" -- hostname >/dev/null

echo "[example-project] 6. run the project task"
set +e
bash_output="$(dim run "$workspace_name" bash -- -lc 'printf project-bash-ok')"
bash_status=$?
set -e
if [[ "$bash_status" -ne 0 || "$bash_output" != "project-bash-ok" ]]; then
  echo "bash task failed ($bash_status), output: '$bash_output'" >&2
  exit 1
fi

echo "[example-project] 7. run a coding agent in the dev container"
# The dev container installs codex/claude via its own startup command, which
# can still be running just after `docker compose up` reports it started.
wait_for_task() {
  local task="$1"
  local attempt
  for attempt in $(seq 1 60); do
    if dim run "$workspace_name" "$task" -- --version >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "timed out waiting for '$task' to become available in the dev container" >&2
  return 1
}
wait_for_task codex
wait_for_task claude
codex_version="$(dim run "$workspace_name" codex -- --version)"
claude_version="$(dim run "$workspace_name" claude -- --version)"
echo "$codex_version" | grep -q "^codex-cli "
echo "$claude_version" | grep -q "(Claude Code)$"
# Without `--`, `--version` is parsed as a flag on `dim run`/`dim-cli`
# itself, not forwarded to the task -- confirm the documented gotcha in the
# README is real: it prints dim-cli's own version, not codex's.
test "$(dim run "$workspace_name" codex --version)" != "$codex_version"

dev_git_identity="$(dim exec "$workspace_name" -- \
  docker compose --file .dim/docker-compose.yml exec -T dev \
  sh -c 'printf "%s <%s>|%s <%s>" "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL" "$GIT_COMMITTER_NAME" "$GIT_COMMITTER_EMAIL"')"
test "$dev_git_identity" = \
  "Example Host Developer <host-developer@dim.invalid>|Example Host Developer <host-developer@dim.invalid>"

echo "[example-project] 8. create a nested container from inside the dev container"
nested_output="$(dim exec "$workspace_name" -- \
  docker compose --file .dim/docker-compose.yml exec -T dev \
  docker run --rm hello-world)"
echo "$nested_output" | grep -q "Hello from Docker!"

echo "[example-project] 9. reach the other repositories from inside the workspace"
web_content="$(dim exec "$workspace_name" -- sh -c \
  'git clone "$DIM_GIT_BASE_URL/web.git" /tmp/web >/dev/null 2>&1 && cat /tmp/web/app.txt')"
test "$web_content" = "hello from example-web"

echo "[example-project] 10. deploy the secret-bearing service at the trusted root boundary"
DIM_BIN="$dim_bin" EXAMPLE_SECRET=not-a-real-secret \
  bash "$repo_root/examples/multi-repo-project/deploy-secret.bash" \
  "$workspace_name" >/dev/null

root_health="$(dim exec "$workspace_name" -- \
  sh ops/secret-service.sh secret-health)"
echo "$root_health" | jq -e '.ok == true and .secretConfigured == true' >/dev/null

dev_health="$(dim run "$workspace_name" bash -- \
  -lc 'wget -qO- http://secret:7099/healthz')"
echo "$dev_health" | jq -e '.ok == true and .secretConfigured == true' >/dev/null

# The agent container has a different Docker daemon and cannot see the
# root-level controller's secret-bearing container or raw secret.
agent_containers="$(dim exec "$workspace_name" -- \
  docker compose --file .dim/docker-compose.yml exec -T dev \
  docker ps --format '{{.Names}}')"
if grep -q secret <<<"$agent_containers"; then
  echo "agent Docker daemon unexpectedly sees the secret-bearing container" >&2
  exit 1
fi
leaked="$(dim exec "$workspace_name" -- \
  docker compose --file .dim/docker-compose.yml exec -T dev \
  sh -c 'env | grep -c EXAMPLE_SECRET || true')"
test "$leaked" = "0"

dim exec "$workspace_name" -- sh ops/secret-service.sh remove-secret >/dev/null

echo "[example-project] 11. clean up"
dim discard "$workspace_name" --yes >/dev/null

echo "example-project-smoke-ok"
