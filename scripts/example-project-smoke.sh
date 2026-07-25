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
# shellcheck source=lib/local-npm-registry.sh
source "$script_dir/lib/local-npm-registry.sh"

suffix="$PPID-$$"
project_name="example-$suffix"
workspace_name="example-dev-$suffix"
secret_image="example-secret-service-$suffix"
secret_container="example-secret-service-$suffix"
work_dir="$(mktemp -d /tmp/dim-example-project.XXXXXX)"
state_root="$work_dir/state"
source_root="$work_dir/source"
install_prefix="$work_dir/install"
dim_bin="$install_prefix/bin/dim"

export DIM_STATE_ROOT="$state_root"
export DIM_WORKSPACE_BACKEND="${DIM_WORKSPACE_BACKEND:-runc}"
export DIM_CONFIG_PATH="$work_dir/config/dim.json"
# Isolate where install-cli puts the versioned DIM CLI too, not just state/
# config: package.json's version doesn't change between local test runs, and
# npm treats an already-installed version as up to date even when a fresh
# local registry republished different content under that same version.
export DIM_DATA_HOME="$work_dir/data"

dim() { "$dim_bin" "$@"; }

cleanup() {
  docker rm --force "$secret_container" >/dev/null 2>&1 || true
  docker image rm "$secret_image" >/dev/null 2>&1 || true
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
npm pack packages/dim-cli/dist --pack-destination "$work_dir" --silent >/dev/null
npm pack packages/install/dist --pack-destination "$work_dir" --silent >/dev/null

echo "[example-project] 1. install DIM through the installer facade"
dim_start_local_npm_registry "$work_dir"
dim_publish_to_local_registry \
  "$work_dir"/*dev-infra-manager-core*.tgz \
  "$work_dir"/*dim-cli*.tgz \
  "$work_dir"/*install-dim*.tgz
mkdir -p "$install_prefix"
npm install --global --prefix "$install_prefix" "$work_dir"/*install-dim*.tgz --silent >/dev/null
"$dim_bin" install-cli --no-local-bin >/dev/null
test -x "$dim_bin"

echo "[example-project] 2. create the example repositories"
examples_dir="$repo_root/examples/multi-repo-project/repos"
mkdir -p "$source_root"
create_repo() {
  local name="$1"
  local path="$source_root/example-$name"
  cp -r "$examples_dir/$name" "$path"
  git init --initial-branch=main "$path" >/dev/null
  git -C "$path" config user.name "Example Project"
  git -C "$path" config user.email "example-project@dim.invalid"
  git -C "$path" add -A
  git -C "$path" commit -m "initial example-$name" >/dev/null
}
create_repo root
create_repo web
create_repo secrets

root_repo="$source_root/example-root"
web_repo="$source_root/example-web"
secrets_repo="$source_root/example-secrets"

echo "[example-project] 3. register the Project and its repositories"
dim project create "$project_name" >/dev/null

dim repo create "$project_name" root --root --ref main --protect main >/dev/null
dim x git -C "$root_repo" push "$(dim repo url-for-host "$project_name" root)" main >/dev/null
dim repo protect "$project_name" root >/dev/null

dim repo create "$project_name" web --protect main >/dev/null
dim x git -C "$web_repo" push "$(dim repo url-for-host "$project_name" web)" main >/dev/null
dim repo protect "$project_name" web >/dev/null

dim repo create "$project_name" secrets --protect main >/dev/null
dim x git -C "$secrets_repo" push "$(dim repo url-for-host "$project_name" secrets)" main >/dev/null
dim repo protect "$project_name" secrets >/dev/null

# The whole point of --protect at create time: confirm the root branch is
# actually protected, not just reported as such (repo protect "succeeds"
# even with nothing configured, per projectRegistry.ts). Re-pushing the
# identical ref would be a silent no-op either way, so make a real commit.
echo "unauthorized change" >> "$root_repo/.dim/entrypoint.sh"
git -C "$root_repo" commit -am "attempted direct push" >/dev/null
if dim x git -C "$root_repo" push "$(dim repo url-for-host "$project_name" root)" main >/dev/null 2>&1; then
  echo "protected branch unexpectedly accepted a direct push" >&2
  exit 1
fi

# Registration must be sufficient: the seed checkouts don't need to survive
# for workspace creation to clone the root repository on its own.
rm -rf "$source_root"

echo "[example-project] 4. create the workspace (a real container)"
dim create "$project_name" "$workspace_name" --backend runc --profile development >/dev/null

echo "[example-project] 5. confirm it's real"
# The workspace's actual container name is an implementation detail of
# `dim`, not something to guess: read it back from `dim show --json` rather
# than assuming a `dim-ws-<name>`-shaped prefix.
workspace_json="$(dim show "$workspace_name" --json)"
test "$(jq -r .phase <<<"$workspace_json")" = "ready"
container_name="$(jq -r .containerName <<<"$workspace_json")"
docker ps --filter "name=$container_name" --format '{{.Names}}' | grep -qx "$container_name"
dim exec "$workspace_name" -- hostname >/dev/null

echo "[example-project] 6. run the project task"
test "$(dim run "$workspace_name" hello)" = "hello from the example project"

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

echo "[example-project] 8. create a nested container from inside the dev container"
nested_output="$(dim exec "$workspace_name" -- \
  docker compose --file .dim/docker-compose.yml exec -T dev \
  docker run --rm hello-world)"
echo "$nested_output" | grep -q "Hello from Docker!"

echo "[example-project] 9. reach the other repositories from inside the workspace"
web_content="$(dim exec "$workspace_name" -- sh -c \
  'git clone "$DIM_GIT_BASE_URL/web.git" /tmp/web >/dev/null 2>&1 && cat /tmp/web/app.txt')"
test "$web_content" = "hello from example-web"

echo "[example-project] 10. deploy the secret-bearing service (outside the workspace)"
docker build --tag "$secret_image" "$examples_dir/secrets" >/dev/null
docker run --detach --name "$secret_container" \
  --env EXAMPLE_SECRET=not-a-real-secret \
  "$secret_image" >/dev/null

healthz=""
for attempt in $(seq 1 30); do
  healthz="$(docker exec "$secret_container" wget -qO- http://127.0.0.1:7099/healthz 2>/dev/null || true)"
  [[ -n "$healthz" ]] && break
  sleep 1
done
echo "$healthz" | jq -e '.ok == true and .secretConfigured == true' >/dev/null

# The actual invariant: the workspace never received the raw secret, because
# nothing about creating or using it ever passes EXAMPLE_SECRET there.
leaked="$(dim exec "$workspace_name" -- sh -c 'env | grep -c EXAMPLE_SECRET || true')"
test "$leaked" = "0"

docker rm --force "$secret_container" >/dev/null
docker image rm "$secret_image" >/dev/null 2>&1 || true

echo "[example-project] 11. clean up"
dim discard "$workspace_name" --yes >/dev/null

echo "example-project-smoke-ok"
