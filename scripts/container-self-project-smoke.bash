#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/git-clone-source.bash
source "$script_dir/lib/git-clone-source.bash"
# shellcheck source=lib/test-registry-mirror.bash
source "$script_dir/lib/test-registry-mirror.bash"

for required_command in ssh ssh-keygen sha256sum; do
  command -v "$required_command" >/dev/null || {
    printf 'unavailable: container self-project smoke requires %s\n' "$required_command" >&2
    exit 2
  }
done

project_name="dim-self-smoke"
workspace_name="dim-self-smoke"
container_name=""
workspace_volume_name=""
state_root="/tmp/dim-self-smoke-state"
source_root="/tmp/dim-self-smoke-source"
agent_verification_log="$state_root/agent-verification.log"
workspace_creation_log="$state_root/workspace-creation.log"
verification_stage="initialization"
dim_bin="${DIM_BIN:-$PWD/core/packages/cli/dist/cli.js}"
project_source="$(cd -- "$script_dir/../.." && pwd)"
integrated_source="$project_source"
# shellcheck source=lib/container-self-project-ssh-fixture.bash
source "$script_dir/lib/container-self-project-ssh-fixture.bash"

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
    workspace_json="$(dim workspace show "$workspace_name" --json)" || return 1
    container_name="$(jq -er .containerName <<<"$workspace_json")" || return 1
    workspace_volume_name="$(jq -er .dockerVolumeName <<<"$workspace_json")" || return 1
    if ! dim workspace discard "$workspace_name" --yes; then
      echo "failed to discard self-project smoke workspace '$workspace_name'" >&2
      failed=1
    fi
  fi
  if [[ -n "$workspace_volume_name" ]] && \
    docker volume inspect "$workspace_volume_name" >/dev/null 2>&1; then
    if ! docker volume rm "$workspace_volume_name" >/dev/null; then
      echo "failed to remove self-project smoke volume '$workspace_volume_name'" >&2
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
prepare_self_ssh_fixture
mkdir -p "$DIM_PLUGIN_HOME"
printf '%s\n' '{"schemaVersion":1,"plugins":[]}' >"$DIM_PLUGIN_HOME/plugins.json"
bash "$script_dir/configure-user-backend.bash" "${DIM_SELF_WORKSPACE_BACKEND:-sysbox}"

cleanup() {
  local status=$?
  trap - EXIT
  if cleanup_managed_resources; then
    if [[ "$status" -ne 0 ]]; then
      echo "self-Project verification failed during: $verification_stage" >&2
    fi
    if [[ "$status" -ne 0 && "$verification_stage" == "workspace creation" && -s "$workspace_creation_log" ]]; then
      echo "workspace creation failed; last 120 log lines:" >&2
      tail -n 120 "$workspace_creation_log" >&2
    fi
    if [[ "$status" -ne 0 && -s "$agent_verification_log" ]]; then
      echo "agent verification failed; last 120 log lines:" >&2
      tail -n 120 "$agent_verification_log" >&2
    fi
    find "$state_root" -depth -delete 2>/dev/null || true
    find "$source_root" -depth -delete 2>/dev/null || true
  else
    echo "retained DIM_STATE_ROOT=$state_root for manual recovery" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ -d "$project_source/project/.git" ]]; then
  mkdir -p "$source_root/repositories"
  for repository in development root core core-development \
    plugin-dns-cloudflare plugin-dns-cloudflare-development \
    plugin-external-urls plugin-external-urls-development verification examples specification; do
    case "$repository" in
      development) repository_source="$project_source" ;;
      root) repository_source="$project_source/project" ;;
      *) repository_source="$project_source/$repository" ;;
    esac
    dim_prepare_clone_source "$repository_source" "$source_root/snapshot-$repository"
    mkdir -p "$source_root/repositories/$repository"
    git -C "$DIM_GIT_CLONE_SOURCE" archive HEAD | tar -x -C "$source_root/repositories/$repository"
  done
else
  echo "split DIM repository set is required for self-Project verification" >&2
  exit 2
fi
project_source="$source_root/repositories/root"
dim_apply_test_registry_mirror "$project_source" agent-dind
mkdir -p "$source_root/remotes"
git init --bare "$source_root/remotes/archive.git" >/dev/null
(
cd -- "$integrated_source/verification"
node --input-type=module - "$project_source/.dim/repos.yml" "$source_root/remotes/archive.git" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
const [manifestPath, archive] = process.argv.slice(2);
const manifest = parse(readFileSync(manifestPath, "utf8"));
for (const [repository, config] of Object.entries(manifest.repositories)) {
  const upstream = config.upstream;
  manifest.upstreams[upstream].url = archive;
  config.import = { main: `dev/${repository}` };
}
writeFileSync(manifestPath, stringify(manifest));
EOF
)

for repository_path in "$source_root"/repositories/*; do
  repository="$(basename "$repository_path")"
  git -C "$repository_path" init --initial-branch="dev/$repository" >/dev/null
  git -C "$repository_path" add -A
  git -C "$repository_path" \
    -c user.name="DIM Snapshot" \
    -c user.email="snapshot@dim.invalid" \
    commit -m "initialize $repository smoke source" >/dev/null
  git -C "$repository_path" push "$source_root/remotes/archive.git" \
    "HEAD:refs/heads/dev/$repository" >/dev/null
done

root_ref=dev/root
dim project create "$project_name" \
  --bootstrap-git-url "$source_root/remotes/archive.git" \
  --bootstrap-git-ref "$root_ref" >/dev/null
verification_stage="workspace creation"
if ! dim workspace create "$project_name" "$workspace_name" \
  > >(tee "$workspace_creation_log") 2>&1; then
  dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-project" --file .dim/docker-compose.yml ps >&2 || true
  dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-project" --file .dim/docker-compose.yml logs --no-color >&2 || true
  exit 1
fi

verification_stage="workspace ready phase"
workspace_json="$(dim workspace show "$workspace_name" --json)"
container_name="$(jq -er .containerName <<<"$workspace_json")"
workspace_volume_name="$(jq -er .dockerVolumeName <<<"$workspace_json")"
test "$(jq -r .phase <<<"$workspace_json")" = ready
verification_stage="workspace runtime manifest"
dim workspace exec "$workspace_name" -- jq -e '
  .schemaVersion == 3 and
  .project.name == "dim-self-smoke" and
  .root.repository == "root" and
  .root.ref == "refs/heads/main" and
  .root.path == "/run/dim/project-root" and
  .data.path == "/var/lib/dim/workspace-data"
' /run/dim/project.json >/dev/null
verification_stage="workspace registry mirror"
dim workspace exec "$workspace_name" -- \
  docker info --format '{{json .RegistryConfig.Mirrors}}' |
  grep -Fq 'http://dim-registry-cache:5000/'
verification_stage="workspace Docker config ownership"
dim workspace exec "$workspace_name" -- sh -eu -c '
  test ! -e "$HOME/.docker" || test "$(stat -c %u "$HOME/.docker")" = "$(id -u)"
'

# shellcheck source=lib/container-self-project-workspace-checks.bash
source "$script_dir/lib/container-self-project-workspace-checks.bash"
# shellcheck source=lib/container-self-project-ssh-checks.bash
source "$script_dir/lib/container-self-project-ssh-checks.bash"
# shellcheck source=lib/container-self-project-agent-checks.bash
source "$script_dir/lib/container-self-project-agent-checks.bash"

verification_stage="repository publication"
dim repo publish "$project_name" >/dev/null
for repository in root development core core-development plugin-dns-cloudflare plugin-dns-cloudflare-development plugin-external-urls plugin-external-urls-development verification examples specification; do
  managed_sha="$(git ls-remote "$(dim repo url "$project_name" "$repository")" refs/heads/main | cut -f1)"
  external_sha="$(git --git-dir="$source_root/remotes/archive.git" rev-parse "refs/heads/dev/$repository")"
  test -n "$managed_sha"
  test "$managed_sha" = "$external_sha"
done

verification_stage="retained agent home across discard and recreation"
retained_sentinel="retained-$PPID-$$-$(date +%s%N)"
dim workspace run "$workspace_name" bash -- -lc \
  "printf '%s\\n' '$retained_sentinel' >\"\$HOME/dim-retained-discard-sentinel\""
dim workspace discard "$workspace_name" --keep-volume --yes >/dev/null
test ! -e "$state_root/workspaces/$workspace_name.json"
test -z "$(docker ps -aq --filter "name=^/$container_name$")"
docker volume inspect "$workspace_volume_name" >/dev/null

dim workspace create "$project_name" "$workspace_name" >/dev/null
workspace_json="$(dim workspace show "$workspace_name" --json)"
container_name="$(jq -er .containerName <<<"$workspace_json")"
workspace_volume_name="$(jq -er .dockerVolumeName <<<"$workspace_json")"
test "$(jq -r .phase <<<"$workspace_json")" = ready
test "$(dim workspace run "$workspace_name" bash -- -lc \
  'cat /home/dim-agent/dim-retained-discard-sentinel')" = "$retained_sentinel"
dim workspace run "$workspace_name" bash -- -lc 'pgrep -x sshd >/dev/null'
record_self_ssh_host_key rotated
assert_self_ssh_session

verification_stage="ordinary workspace discard"
dim workspace discard "$workspace_name" --yes >/dev/null
if docker volume inspect "$workspace_volume_name" >/dev/null 2>&1; then
  echo "ordinary discard retained outer volume '$workspace_volume_name'" >&2
  exit 1
fi
dim project purge "$project_name" --yes >/dev/null
echo "container-self-project-smoke-ok"
