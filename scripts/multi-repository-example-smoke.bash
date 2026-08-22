#!/usr/bin/env bash
set -euo pipefail

# Executes examples/projects/multi-repository/README.md, command for command,
# against a real Docker daemon and the environment's managed Gitea. Update
# that doc (and the repository skeletons under
# examples/projects/multi-repository/repos/)
# alongside this script if either changes; it
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
# shellcheck source=lib/example-dim-install.bash
source "$script_dir/lib/example-dim-install.bash"
# shellcheck source=lib/test-registry-mirror.bash
source "$script_dir/lib/test-registry-mirror.bash"

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
workspace_backend="${DIM_EXAMPLE_WORKSPACE_BACKEND:-runc}"
bash "$script_dir/configure-user-backend.bash" "$workspace_backend"

dim() { "$dim_bin" "$@"; }

cleanup() {
  if [[ -f "$state_root/workspaces/$workspace_name.json" ]]; then
    dim workspace discard "$workspace_name" --yes >/dev/null 2>&1 || true
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
echo "[multi-repository] build and pack local packages"
echo "[multi-repository] 1. install DIM through the installer facade"
dim_install_example_cli "$repo_root" "$work_dir" "$install_prefix"
test "$DIM_EXAMPLE_DIM_BIN" = "$dim_bin"
test -x "$dim_bin"
docker build \
  --quiet \
  --build-arg "DIM_UID=$(id -u)" \
  --build-arg "DIM_GID=$(id -g)" \
  --tag dev-infra-project-workspace:latest \
  --file "$repo_root/images/project-workspace/Dockerfile" \
  "$repo_root" >/dev/null
dim doctor

echo "[multi-repository] 2. create the example repositories"
bash "$repo_root/examples/projects/multi-repository/create-repositories.bash" \
  "$source_root" >/dev/null

root_repo="$source_root/root"
dim_apply_test_registry_mirror "$root_repo"
if [[ -n "${DIM_DOCKER_REGISTRY_MIRROR:-}" ]]; then
  git -C "$root_repo" add .dim/setup.sh .dim/ci-registry-mirror.override.yml
  git -C "$root_repo" commit -m "configure test registry mirror" >/dev/null
fi

echo "[multi-repository] 3. register the Project and its repositories"
DIM_BIN="$dim_bin" bash \
  "$repo_root/examples/projects/multi-repository/register-project.bash" \
  "$project_name" "$source_root" >/dev/null

# The whole point of --protect at create time: confirm the root branch is
# actually protected, not just reported as such (repo protect "succeeds"
# even with nothing configured, per projectRegistry.ts). Re-pushing the
# identical ref would be a silent no-op either way, so make a real commit.
printf '\n' >> "$root_repo/.dim/docker-compose.yml"
git -C "$root_repo" commit -am "attempted direct push" >/dev/null
if dim x git -C "$root_repo" push "$(dim repo url "$project_name" root)" main >/dev/null 2>&1; then
  echo "protected branch unexpectedly accepted a direct push" >&2
  exit 1
fi

# Registration must be sufficient: the seed checkouts don't need to survive
# for workspace creation to clone the root repository on its own.
rm -rf "$source_root"

echo "[example-project] 4. create the workspace (a real container)"
if ! dim workspace create "$project_name" "$workspace_name" >/dev/null; then
  dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-$workspace_name" \
    --file .dim/docker-compose.yml ps --all >&2 || true
  dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-$workspace_name" \
    --file .dim/docker-compose.yml logs agent-dind >&2 || true
  exit 1
fi

echo "[example-project] 5. confirm it's real"
# The workspace's actual container name is an implementation detail of
# `dim`, not something to guess: read it back from `dim workspace show --json` rather
# than assuming a `dim-ws-<name>`-shaped prefix.
workspace_json="$(dim workspace show "$workspace_name" --json)"
test "$(jq -r .phase <<<"$workspace_json")" = "ready"
test "$(jq -r .runtimeBackend <<<"$workspace_json")" = "$workspace_backend"
test "$(jq -r '.profiles | length' <<<"$workspace_json")" = "0"
container_name="$(jq -r .containerName <<<"$workspace_json")"
docker ps --filter "name=$container_name" --format '{{.Names}}' | grep -qx "$container_name"
dim workspace exec "$workspace_name" -- hostname >/dev/null
original_cpus="$(jq -r .cpuCount <<<"$workspace_json")"
original_memory="$(jq -r .memory <<<"$workspace_json")"
original_pids="$(jq -r .pidsLimit <<<"$workspace_json")"
updated_resources="$(dim workspace resources "$workspace_name" \
  --cpus 1.25 --memory 2g --processes 1024 --json)"
test "$(jq -r .cpuCount <<<"$updated_resources")" = "1.25"
test "$(jq -r .memory <<<"$updated_resources")" = "2g"
test "$(jq -r .pidsLimit <<<"$updated_resources")" = "1024"
test "$(docker inspect "$container_name" --format \
  '{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.PidsLimit}}')" = \
  "1250000000|2147483648|2147483648|1024"
dim workspace resources "$workspace_name" \
  --cpus "$original_cpus" --memory "$original_memory" --processes "$original_pids" >/dev/null

echo "[example-project] 6. run the project task"
set +e
bash_output="$(dim workspace run "$workspace_name" bash -- -lc 'printf project-bash-ok')"
bash_status=$?
set -e
if [[ "$bash_status" -ne 0 || "$bash_output" != "project-bash-ok" ]]; then
  echo "bash task failed ($bash_status), output: '$bash_output'" >&2
  exit 1
fi
dim workspace run "$workspace_name" bash -- -lc 'printf "multi-home\n" >"$HOME/archive-smoke"'
home_backup="$work_dir/agent-home.tar.gz"
dim workspace run "$workspace_name" backup >"$home_backup"
gzip -t "$home_backup"
dim workspace run "$workspace_name" bash -- -lc 'rm "$HOME/archive-smoke"'
dim workspace run "$workspace_name" restore <"$home_backup"
test "$(dim workspace run "$workspace_name" bash -- -lc 'cat "$HOME/archive-smoke"')" = multi-home

echo "[example-project] 7. run a coding agent in the dev container"
# The dev container installs codex/claude via its own startup command, which
# can still be running just after `docker compose up` reports it started.
wait_for_task() {
  local task="$1"
  local attempt
  for attempt in $(seq 1 60); do
    if dim workspace run "$workspace_name" "$task" -- --version >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "timed out waiting for '$task' to become available in the dev container" >&2
  return 1
}
wait_for_task codex
wait_for_task claude
codex_version="$(dim workspace run "$workspace_name" codex -- --version)"
claude_version="$(dim workspace run "$workspace_name" claude -- --version)"
echo "$codex_version" | grep -q "^codex-cli "
echo "$claude_version" | grep -q "(Claude Code)$"
# Without `--`, `--version` is parsed as a flag on `dim workspace run`/`dim-cli`
# itself, not forwarded to the task -- confirm the documented gotcha in the
# README is real: it prints dim-cli's own version, not codex's.
test "$(dim workspace run "$workspace_name" codex --version)" != "$codex_version"

dev_git_identity="$(dim workspace run "$workspace_name" bash -- \
  -lc 'printf "%s <%s>|%s <%s>" "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL" "$GIT_COMMITTER_NAME" "$GIT_COMMITTER_EMAIL"')"
test "$dev_git_identity" = \
  "Example Host Developer <host-developer@dim.invalid>|Example Host Developer <host-developer@dim.invalid>"
agent_commit_identity="$(dim workspace run "$workspace_name" bash -- -lc '
  printf "%s\n" "agent commit" > agent-commit.txt
  git add agent-commit.txt
  git commit -m "verify host identity" >/dev/null
  git log -1 --format="%an <%ae>|%cn <%ce>"
')"
test "$agent_commit_identity" = "$dev_git_identity"

agent_container="$(dim workspace exec "$workspace_name" -- \
  docker compose --project-name "dim-$workspace_name" \
  --file .dim/docker-compose.yml ps --quiet agent)"
test -n "$agent_container"
test "$(dim workspace exec "$workspace_name" -- docker inspect "$agent_container" \
  --format '{{range .Mounts}}{{if eq .Destination "/home/dim-agent"}}{{.Type}}|{{.RW}}{{end}}{{end}}')" = \
  "volume|true"
dim workspace exec "$workspace_name" -- docker inspect "$agent_container" \
  --format '{{.HostConfig.Privileged}}' | grep -qx false
! dim workspace exec "$workspace_name" -- docker inspect "$agent_container" \
  --format '{{json .Mounts}}' | grep -q /var/run/docker.sock
dind_container="$(dim workspace exec "$workspace_name" -- \
  docker compose --project-name "dim-$workspace_name" \
  --file .dim/docker-compose.yml ps --quiet agent-dind)"
test -n "$dind_container"
if [[ -n "${DIM_DOCKER_REGISTRY_MIRROR:-}" ]]; then
  dim workspace exec "$workspace_name" -- \
    docker exec "$dind_container" docker info --format '{{json .RegistryConfig.Mirrors}}' |
    grep -Fq "$DIM_DOCKER_REGISTRY_MIRROR"
fi
dim workspace exec "$workspace_name" -- docker inspect "$dind_container" \
  --format '{{.HostConfig.Privileged}}' | grep -qx true
dim workspace exec "$workspace_name" -- docker exec "$dind_container" \
  sh -eu -c 'test -u /usr/bin/newuidmap; test -u /usr/bin/newgidmap'
dim workspace run "$workspace_name" bash -- -lc '
  docker info --format "{{json .SecurityOptions}}" | grep -q rootless
  rm -rf /mnt/workspace-shared-dind/bind-smoke
  mkdir -m 0777 /mnt/workspace-shared-dind/bind-smoke
  printf "from-agent\n" > /mnt/workspace-shared-dind/bind-smoke/input
  docker run --rm \
    --mount type=bind,source=/mnt/workspace-shared-dind/bind-smoke,target=/shared \
    alpine:3.22 sh -c \
      "test \"\$(cat /shared/input)\" = from-agent; printf \"from-dind\\n\" > /shared/output"
  test "$(cat /mnt/workspace-shared-dind/bind-smoke/output)" = from-dind
'

echo "[example-project] 8. create a nested container from inside the dev container"
nested_output="$(dim workspace run "$workspace_name" bash -- \
  -lc 'docker run --rm hello-world')"
echo "$nested_output" | grep -q "Hello from Docker!"

echo "[example-project] 9. reach another managed repository"
web_content="$(dim workspace exec "$workspace_name" -- sh -c \
  'git clone "$DIM_GIT_BASE_URL/web.git" /tmp/web >/dev/null 2>&1 && cat /tmp/web/app.txt')"
test "$web_content" = "hello from example-web"

echo "[example-project] 10. deploy the secret-bearing service at the trusted root boundary"
DIM_BIN="$dim_bin" EXAMPLE_SECRET=not-a-real-secret \
  bash "$repo_root/examples/projects/multi-repository/deploy-secret.bash" \
  "$workspace_name" >/dev/null

root_health="$(dim workspace exec "$workspace_name" -- \
  sh ops/secret-service.sh secret-health)"
echo "$root_health" | jq -e '.ok == true and .secretConfigured == true' >/dev/null

dev_health="$(dim workspace run "$workspace_name" bash -- \
  -lc 'wget -qO- http://secret:7099/healthz')"
echo "$dev_health" | jq -e '.ok == true and .secretConfigured == true' >/dev/null

# The agent container has a different Docker daemon and cannot see the
# root-level controller's secret-bearing container or raw secret.
agent_containers="$(dim workspace run "$workspace_name" bash -- \
  -lc "docker ps --format '{{.Names}}'")"
if grep -q secret <<<"$agent_containers"; then
  echo "agent Docker daemon unexpectedly sees the secret-bearing container" >&2
  exit 1
fi
leaked="$(dim workspace run "$workspace_name" bash -- \
  -lc 'env | grep -c EXAMPLE_SECRET || true')"
test "$leaked" = "0"

dim workspace exec "$workspace_name" -- sh ops/secret-service.sh remove-secret >/dev/null

echo "[example-project] 11. clean up"
dim workspace discard "$workspace_name" --yes >/dev/null

echo "multi-repository-example-smoke-ok"
