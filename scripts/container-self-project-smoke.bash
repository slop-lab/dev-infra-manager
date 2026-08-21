#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/git-clone-source.bash
source "$script_dir/lib/git-clone-source.bash"

project_name="dim-self-smoke"
workspace_name="dim-self-smoke"
state_root="/tmp/dim-self-smoke-state"
source_root="/tmp/dim-self-smoke-source"
dim_bin="${DIM_BIN:-$PWD/packages/cli/dist/cli.js}"
project_source="$PWD"

exec 9> /tmp/dim-self-smoke.lock
if ! flock --nonblock 9; then
  echo "another container self-project smoke is already running" >&2
  exit 1
fi

dim() {
  if [[ -n "${DIM_BIN:-}" ]]; then
    command "$dim_bin" "$@"
  else
    node "$dim_bin" "$@"
  fi
}

export DIM_STATE_ROOT="$state_root"
export DIM_CONFIG_PATH="$state_root/dim.json"
export DIM_PLUGIN_HOME="$state_root/plugins"
export GIT_CONFIG_GLOBAL="$state_root/host.gitconfig"

cleanup_managed_resources() {
  local failed=0
  if [[ -f "$state_root/workspaces/$workspace_name.json" ]]; then
    if ! dim workspace discard "$workspace_name" --yes; then
      echo "failed to discard self-project smoke workspace '$workspace_name'" >&2
      failed=1
    fi
  fi
  if [[ -f "$state_root/projects/$project_name.json" ]]; then
    if ! dim project purge "$project_name" --yes; then
      echo "failed to purge self-project smoke Project '$project_name'" >&2
      failed=1
    fi
  fi
  return "$failed"
}

if [[ -d "$state_root" ]]; then
  echo "recover previous container self-project smoke state"
  if ! cleanup_managed_resources; then
    echo "retained DIM_STATE_ROOT=$state_root for manual recovery" >&2
    exit 1
  fi
  find "$state_root" -depth -delete
  find "$source_root" -depth -delete 2>/dev/null || true
fi

mkdir -p "$state_root" "$source_root"
git config --file "$GIT_CONFIG_GLOBAL" user.name "DIM Self Host"
git config --file "$GIT_CONFIG_GLOBAL" user.email "dim-self-host@dim.invalid"
mkdir -p "$DIM_PLUGIN_HOME"
printf '%s\n' '{"schemaVersion":1,"plugins":[]}' > "$DIM_PLUGIN_HOME/plugins.json"
bash "$script_dir/configure-user-backend.bash" runc

cleanup() {
  local status=$?
  trap - EXIT
  if cleanup_managed_resources; then
    find "$state_root" -depth -delete 2>/dev/null || true
    find "$source_root" -depth -delete 2>/dev/null || true
  else
    echo "retained DIM_STATE_ROOT=$state_root for manual recovery" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT

dim_prepare_clone_source "$project_source" "$source_root/snapshot"
git clone "$DIM_GIT_CLONE_SOURCE" "$source_root/materialized" >/dev/null
project_source="$source_root/materialized"

temporary_manifest="$project_source/.dim/repos.yml.tmp"
sed "s#^    url:.*#    url: $source_root/project.git#" \
  "$project_source/.dim/repos.yml" >"$temporary_manifest"
mv "$temporary_manifest" "$project_source/.dim/repos.yml"
git -C "$project_source" add .dim/repos.yml
git -C "$project_source" \
  -c user.name="DIM Snapshot" \
  -c user.email="snapshot@dim.invalid" \
  commit -m "point self manifest at smoke source" >/dev/null

git clone --bare "$project_source" "$source_root/project.git" >/dev/null
root_ref="$(git -C "$project_source" rev-parse --abbrev-ref HEAD)"
dim project create "$project_name" \
  --repos "$project_source/.dim/repos.yml" --yes >/dev/null
if ! dim workspace create "$project_name" "$workspace_name" >/dev/null; then
  dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-$workspace_name" \
    --file .dim/docker-compose.yml ps --all >&2 || true
  dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-$workspace_name" \
    --file .dim/docker-compose.yml logs --no-color >&2 || true
  exit 1
fi

workspace_json="$(dim workspace show "$workspace_name" --json)"
test "$(jq -r .phase <<<"$workspace_json")" = ready

verify_rootless_dind() {
  local dind_container
  dind_container="$(dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-$workspace_name" \
    --file .dim/docker-compose.yml ps --quiet agent-dind)"
  test -n "$dind_container"
  dim workspace exec "$workspace_name" -- \
    docker inspect --format '{{.State.Health.Status}}' "$dind_container" | grep -qx healthy
  dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-$workspace_name" \
    --file .dim/docker-compose.yml exec --no-TTY --user root agent-dind \
    sh -eu -c '
      test -u /usr/bin/newuidmap
      test -u /usr/bin/newgidmap
      test "$(stat -c %u:%g /home/rootless/.local/share/docker)" = 1000:1000
      test "$(stat -c %u:%g /run/user/1000)" = 1000:1000
      test "$(stat -c %a /run/user/1000)" = 700
    '
}

verify_rootless_dind
if ! dim workspace restart "$workspace_name" >/dev/null; then
  dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-$workspace_name" \
    --file .dim/docker-compose.yml ps --all >&2 || true
  dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-$workspace_name" \
    --file .dim/docker-compose.yml logs --no-color agent-dind >&2 || true
  exit 1
fi
workspace_json="$(dim workspace show "$workspace_name" --json)"
test "$(jq -r .phase <<<"$workspace_json")" = ready
verify_rootless_dind

original_cpus="$(jq -r .cpuCount <<<"$workspace_json")"
original_memory="$(jq -r .memory <<<"$workspace_json")"
original_pids="$(jq -r .pidsLimit <<<"$workspace_json")"
if [[ -c /dev/kvm ]]; then
  test "$(jq -r .kvm <<<"$workspace_json")" = "true"
  test "$(dim workspace exec "$workspace_name" -- sh .dim/kvm.sh)" = "workspace-kvm-ok"
else
  test "$(jq -r .kvm <<<"$workspace_json")" = "false"
  dim workspace exec "$workspace_name" -- sh -c 'test ! -e /dev/kvm'
fi
updated_resources="$(dim workspace resources "$workspace_name" \
  --cpus 1.25 --memory 2g --processes 1024 --json)"
test "$(jq -r .cpuCount <<<"$updated_resources")" = "1.25"
test "$(jq -r .memory <<<"$updated_resources")" = "2g"
test "$(jq -r .pidsLimit <<<"$updated_resources")" = "1024"
container_name="$(jq -r .containerName <<<"$workspace_json")"
test "$(docker inspect "$container_name" --format \
  '{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.PidsLimit}}')" = \
  "1250000000|2147483648|2147483648|1024"
dim workspace resources "$workspace_name" \
  --cpus "$original_cpus" --memory "$original_memory" --processes "$original_pids" >/dev/null
dim workspace exec "$workspace_name" -- \
  sh -c 'test -r .dim/setup.sh && test ! -x .dim/setup.sh && test -r .dim/entrypoint.sh && test ! -x .dim/entrypoint.sh && test -r .dim/docker-compose.yml && test "$DIM_GIT_BASE_URL" = "$(jq -r .gitBaseUrl "$DIM_PROJECT_MANIFEST")" && test -n "$(jq -r ".hostAliases[\"dim-gitea\"][0]" "$DIM_PROJECT_MANIFEST")"'
test "$(dim workspace show "$workspace_name" --json | jq -r .rootRef)" = "refs/heads/$root_ref"
agent_git_identity="$(dim workspace run "$workspace_name" bash -- -lc \
  'printf "%s <%s>|%s <%s>" "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL" "$GIT_COMMITTER_NAME" "$GIT_COMMITTER_EMAIL"')"
test "$agent_git_identity" = \
  "DIM Self Host <dim-self-host@dim.invalid>|DIM Self Host <dim-self-host@dim.invalid>"
dim workspace run "$workspace_name" bash -- -lc '
  test "$HOME" = /home/dim-agent
  printf "persistent\n" > "$HOME/dim-home-smoke"
'
test "$(dim workspace run "$workspace_name" bash -- -lc 'cat "$HOME/dim-home-smoke"')" = persistent
home_backup="$state_root/agent-home.tar.gz"
dim workspace run "$workspace_name" backup >"$home_backup"
gzip -t "$home_backup"
dim workspace run "$workspace_name" bash -- -lc 'rm "$HOME/dim-home-smoke"'
dim workspace run "$workspace_name" restore <"$home_backup"
test "$(dim workspace run "$workspace_name" bash -- -lc 'cat "$HOME/dim-home-smoke"')" = persistent
dim workspace run "$workspace_name" bash -- -lc '
  test -n "$(getent hosts dim-gitea)"
  git ls-remote origin HEAD >/dev/null
'
agent_commit_identity="$(dim workspace run "$workspace_name" bash -- -lc '
  printf "%s\n" "self agent commit" > self-agent-commit.txt
  git add self-agent-commit.txt
  git commit -m "verify self agent host identity" >/dev/null
  git log -1 --format="%an <%ae>|%cn <%ce>"
')"
test "$agent_commit_identity" = "$agent_git_identity"
agent_container="$(dim workspace exec "$workspace_name" -- \
  docker compose --project-name "dim-$workspace_name" \
  --file .dim/docker-compose.yml ps --quiet agent)"
test -n "$agent_container"
test "$(dim workspace exec "$workspace_name" -- docker inspect "$agent_container" \
  --format '{{range .Mounts}}{{if eq .Destination "/home/dim-agent"}}{{.Type}}|{{.RW}}{{end}}{{end}}')" = \
  "volume|true"
dim workspace exec "$workspace_name" -- docker inspect --format '{{.HostConfig.Privileged}}' \
  "$agent_container" | grep -qx false
! dim workspace exec "$workspace_name" -- docker inspect --format '{{json .Mounts}}' \
  "$agent_container" | grep -q /var/run/docker.sock
dind_container="$(dim workspace exec "$workspace_name" -- \
  docker compose --project-name "dim-$workspace_name" \
  --file .dim/docker-compose.yml ps --quiet agent-dind)"
dim workspace exec "$workspace_name" -- docker inspect --format '{{.HostConfig.Privileged}}' \
  "$dind_container" | grep -qx true
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
dim workspace run "$workspace_name" bash -- -lc 'just typecheck' >/dev/null
test "$(dim workspace run "$workspace_name" codex -- --version)" != ""
if dim workspace run "$workspace_name" check >/dev/null 2>&1; then
  echo "removed check task unexpectedly succeeded" >&2
  exit 1
fi
dim workspace run "$workspace_name" bash -- -lc 'just check' >/dev/null
if [[ "${DIM_SELF_VERIFY_AGENT:-0}" == 1 ]]; then
  dim workspace run "$workspace_name" bash -- -lc 'just verify agent'
fi

dim workspace discard "$workspace_name" --yes >/dev/null
dim project purge "$project_name" --yes >/dev/null

echo "container-self-project-smoke-ok"
