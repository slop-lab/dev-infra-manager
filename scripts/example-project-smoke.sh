#!/usr/bin/env bash
set -euo pipefail

# Executes docs/example-project.md, command for command, against a real
# Docker daemon and the environment's managed Gitea. Update that doc
# alongside this script if either changes; it exists specifically so the doc
# cannot silently drift from what actually works.
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
work_dir="$(mktemp -d /tmp/dim-example-project.XXXXXX)"
state_root="$work_dir/state"
source_root="$work_dir/source"
install_prefix="$work_dir/install"
dim_bin="$install_prefix/bin/dim"

export DIM_STATE_ROOT="$state_root"
export DIM_WORKSPACE_BACKEND="${DIM_WORKSPACE_BACKEND:-runc}"
export DIM_CONFIG_PATH="$work_dir/config/dim.json"

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

echo "[example-project] 2. write the example repositories"
create_repo() {
  local name="$1" path="$2"
  git init --initial-branch=main "$path" >/dev/null
  git -C "$path" config user.name "Example Project"
  git -C "$path" config user.email "example-project@dim.invalid"
  git -C "$path" add -A
  git -C "$path" commit -m "initial $name" >/dev/null
}

root_repo="$source_root/example-root"
web_repo="$source_root/example-web"
secrets_repo="$source_root/example-secrets"

mkdir -p "$root_repo/.dim"
printf '%s\n' \
  'services:' \
  '  dev:' \
  '    image: alpine:3.22' \
  '    command: ["sleep", "infinity"]' \
  > "$root_repo/.dim/docker-compose.yml"
printf '%s\n' \
  '#!/usr/bin/env sh' \
  'set -eu' \
  'task="${1:?task is required}"' \
  'shift' \
  'case "$task" in' \
  '  hello) echo "hello from the example project" ;;' \
  '  *) echo "unknown task: $task" >&2; exit 2 ;;' \
  'esac' \
  > "$root_repo/.dim/entrypoint.sh"
create_repo example-root "$root_repo"

mkdir -p "$web_repo"
printf '%s\n' 'hello from example-web' > "$web_repo/app.txt"
create_repo example-web "$web_repo"

mkdir -p "$secrets_repo"
printf '%s\n' 'PLACEHOLDER_SECRET=not-a-real-secret' > "$secrets_repo/env.txt"
create_repo example-secrets "$secrets_repo"

echo "[example-project] 3. register the Project and its repositories"
dim project create "$project_name" >/dev/null

dim repo create "$project_name" root --root --ref main >/dev/null
dim x git -C "$root_repo" push "$(dim repo url-for-host "$project_name" root)" main >/dev/null
dim repo protect "$project_name" root >/dev/null

dim repo create "$project_name" web >/dev/null
dim x git -C "$web_repo" push "$(dim repo url-for-host "$project_name" web)" main >/dev/null
dim repo protect "$project_name" web >/dev/null

dim repo create "$project_name" secrets >/dev/null
dim x git -C "$secrets_repo" push "$(dim repo url-for-host "$project_name" secrets)" main >/dev/null
dim repo protect "$project_name" secrets >/dev/null

# Registration must be sufficient: the seed checkouts don't need to survive
# for workspace creation to clone the root repository on its own.
rm -rf "$source_root"

echo "[example-project] 4. create the workspace (a real container)"
dim create "$project_name" "$workspace_name" --backend runc --profile development >/dev/null

echo "[example-project] 5. confirm it's real"
phase="$(dim show "$workspace_name" --json \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).phase))')"
test "$phase" = "ready"
docker ps --filter "name=dim-ws-${workspace_name}" --format '{{.Names}}' | grep -q "dim-ws-${workspace_name}"
dim exec "$workspace_name" -- hostname >/dev/null

echo "[example-project] 6. run the project task"
test "$(dim run "$workspace_name" hello)" = "hello from the example project"

echo "[example-project] 7. reach the other repositories from inside the workspace"
web_content="$(dim exec "$workspace_name" -- sh -c \
  'git clone "$DIM_GIT_BASE_URL/web.git" /tmp/web >/dev/null 2>&1 && cat /tmp/web/app.txt')"
test "$web_content" = "hello from example-web"

echo "[example-project] 8. clean up"
dim discard "$workspace_name" --yes >/dev/null

echo "example-project-smoke-ok"
