#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/git-clone-source.bash
source "$script_dir/lib/git-clone-source.bash"
# shellcheck source=lib/test-registry-mirror.bash
source "$script_dir/lib/test-registry-mirror.bash"

project_name="dim-self-smoke"
workspace_name="dim-self-smoke"
state_root="/tmp/dim-self-smoke-state"
source_root="/tmp/dim-self-smoke-source"
agent_verification_log="$state_root/agent-verification.log"
workspace_creation_log="$state_root/workspace-creation.log"
verification_stage="initialization"
dim_bin="${DIM_BIN:-$PWD/core/packages/cli/dist/cli.js}"
project_source="$(cd -- "$script_dir/../.." && pwd)"
integrated_source="$project_source"

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
    if [[ "$status" -ne 0 ]]; then
      echo "self-Project verification failed during: $verification_stage" >&2
    fi
    if [[ "$status" -ne 0 && -s "$workspace_creation_log" ]]; then
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
manifest.upstreams.archive.url = archive;
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
  >"$workspace_creation_log" 2>&1; then
  dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-$workspace_name" \
    --file .dim/docker-compose.yml ps --all >&2 || true
  dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-$workspace_name" \
    --file .dim/docker-compose.yml logs --no-color >&2 || true
  exit 1
fi

verification_stage="workspace ready phase"
workspace_json="$(dim workspace show "$workspace_name" --json)"
test "$(jq -r .phase <<<"$workspace_json")" = ready
verification_stage="workspace repository manifest"
expected_repositories='["core","core-development","development","examples","plugin-dns-cloudflare","plugin-dns-cloudflare-development","plugin-external-urls","plugin-external-urls-development","root","specification","verification"]'
test "$(dim workspace exec "$workspace_name" -- jq -c '.repositories | keys' /run/dim/project.json)" = \
  "$expected_repositories"
verification_stage="workspace registry mirror"
dim workspace exec "$workspace_name" -- \
  docker info --format '{{json .RegistryConfig.Mirrors}}' |
  grep -Fq 'http://dim-registry-cache:5000/'

verify_agent_dind() {
  local agent_dind_container
  agent_dind_container="$(dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-$workspace_name" \
    --file .dim/docker-compose.yml ps --quiet agent-dind)"
  test -n "$agent_dind_container"
  dim workspace exec "$workspace_name" -- \
    docker inspect --format '{{.State.Health.Status}}' "$agent_dind_container" | grep -qx healthy
  if [[ -n "${DIM_DOCKER_REGISTRY_MIRROR:-}" ]]; then
    dim workspace exec "$workspace_name" -- \
      docker exec "$agent_dind_container" docker info --format '{{json .RegistryConfig.Mirrors}}' |
      grep -Fq "$DIM_DOCKER_REGISTRY_MIRROR"
  fi
  dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-$workspace_name" \
    --file .dim/docker-compose.yml exec --no-TTY --user root agent-dind \
    sh -eu -c '
      test -S /run/docker.sock
      test -d /var/lib/docker
      test "$(stat -c %u:%g /mnt/agent-home)" = "$(stat -c %u:%g /workspace)"
      ! docker info --format "{{json .SecurityOptions}}" | grep -q rootless
    '
}

verification_stage="initial agent-dind contract"
verify_agent_dind
verification_stage="workspace restart"
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
verification_stage="restarted agent-dind contract"
verify_agent_dind

verification_stage="workspace resource update"
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
  --cpus 1.25 --memory 2g --pids 1024 --json)"
test "$(jq -r .cpuCount <<<"$updated_resources")" = "1.25"
test "$(jq -r .memory <<<"$updated_resources")" = "2g"
test "$(jq -r .pidsLimit <<<"$updated_resources")" = "1024"
container_name="$(jq -r .containerName <<<"$workspace_json")"
test "$(docker inspect "$container_name" --format \
  '{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.PidsLimit}}')" = \
  "1250000000|2147483648|2147483648|1024"
dim workspace resources "$workspace_name" \
  --cpus "$original_cpus" --memory "$original_memory" --pids "$original_pids" >/dev/null
verification_stage="workspace reviewed-file contract"
dim workspace exec "$workspace_name" -- \
  sh -c 'test -r .dim/setup.sh && test ! -x .dim/setup.sh && test -r .dim/entrypoint.sh && test ! -x .dim/entrypoint.sh && test -r .dim/docker-compose.yml && test "$DIM_GIT_BASE_URL" = "$(jq -r .gitBaseUrl "$DIM_PROJECT_MANIFEST")" && test -n "$(jq -r ".hostAliases[\"dim-gitea\"][0]" "$DIM_PROJECT_MANIFEST")"'
test "$(dim workspace show "$workspace_name" --json | jq -r .rootRef)" = "refs/heads/$root_ref"
agent_git_identity="$(dim workspace run "$workspace_name" bash -- -lc \
  'printf "%s <%s>|%s <%s>" "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL" "$GIT_COMMITTER_NAME" "$GIT_COMMITTER_EMAIL"')"
test "$agent_git_identity" = \
  "DIM Self Host <dim-self-host@dim.invalid>|DIM Self Host <dim-self-host@dim.invalid>"
verification_stage="agent base toolchain and home persistence"
workspace_owner_uid="$(dim workspace exec "$workspace_name" -- stat -c %u /workspace)"
agent_uid="$(dim workspace run "$workspace_name" bash -- -lc 'id -u')"
test "$agent_uid" = "$workspace_owner_uid"
if [[ -n "${DIM_SELF_EXPECT_AGENT_UID:-}" ]]; then
  test "$agent_uid" = "$DIM_SELF_EXPECT_AGENT_UID"
fi
dim workspace run "$workspace_name" bash -- -lc '
  grep -q "Ubuntu 24.04" /etc/os-release
  node --version | grep -Eq "^v24\."
  docker compose version >/dev/null
  just --version >/dev/null
  test "$HOME" = /home/dim-agent
  printf "persistent\n" > "$HOME/dim-home-smoke"
'
test "$(dim workspace run "$workspace_name" bash -- -lc 'cat "$HOME/dim-home-smoke"')" = persistent
verification_stage="agent home backup and restore"
home_backup="$state_root/agent-home.tar.gz"
dim workspace run "$workspace_name" backup >"$home_backup"
gzip -t "$home_backup"
dim workspace run "$workspace_name" bash -- -lc 'rm "$HOME/dim-home-smoke"'
dim workspace run "$workspace_name" restore <"$home_backup"
test "$(dim workspace run "$workspace_name" bash -- -lc 'cat "$HOME/dim-home-smoke"')" = persistent
verification_stage="agent repository materialization"
dim workspace run "$workspace_name" bash -- -lc '
  test -n "$(getent hosts dim-gitea)"
  git ls-remote origin HEAD >/dev/null
  test "$(git branch --show-current)" = main
  test -z "$(git status --short)"
  test -r AGENTS.md
  test -r .agents/skills/pull-request/SKILL.md
  for repository in core core-development plugin-dns-cloudflare plugin-dns-cloudflare-development plugin-external-urls plugin-external-urls-development verification examples specification; do
    test -d "/workspace/$repository/.git"
    test "$(git -C "/workspace/$repository" branch --show-current)" = main
  done
'
agent_commit_identity="$(dim workspace run "$workspace_name" bash -- -lc '
  printf "%s\n" "self agent commit" > self-agent-commit.txt
  git add self-agent-commit.txt
  git commit -m "verify self agent host identity" >/dev/null
  git log -1 --format="%an <%ae>|%cn <%ce>"
')"
test "$agent_commit_identity" = "$agent_git_identity"
verification_stage="protected and unprotected repository pushes"
# Only root and development main are review-gated in the self Project.
if dim workspace run "$workspace_name" bash -- -lc \
  'git push origin HEAD:refs/heads/main >/dev/null 2>&1'; then
  echo 'protected development main accepted a workspace push' >&2
  exit 1
fi
core_proposal=agent/split-repository-smoke
dim workspace run "$workspace_name" bash -- -lc "
  cd /workspace/core
  git checkout -b '$core_proposal'
  printf 'split proposal\n' > split-proposal.txt
  git add split-proposal.txt
  git commit -m 'verify split repository proposal' >/dev/null
  git push origin HEAD:'refs/heads/$core_proposal' >/dev/null
  git push origin HEAD:refs/heads/main >/dev/null
"
git ls-remote "$(dim repo url "$project_name" core)" "refs/heads/$core_proposal" | grep -q .
verification_stage="agent-dind mount and privilege contract"
agent_dind_container="$(dim workspace exec "$workspace_name" -- \
  docker compose --project-name "dim-$workspace_name" \
  --file .dim/docker-compose.yml ps --quiet agent-dind)"
test -n "$agent_dind_container"
test "$(dim workspace exec "$workspace_name" -- docker inspect "$agent_dind_container" \
  --format '{{range .Mounts}}{{if eq .Destination "/mnt/agent-home"}}{{.Type}}|{{.RW}}{{end}}{{end}}')" = \
  "volume|true"
test "$(dim workspace exec "$workspace_name" -- \
  docker exec "$agent_dind_container" dim-agent-dind inspect \
  --format '{{range .Mounts}}{{if eq .Destination "/home/dim-agent"}}{{.Type}}|{{.RW}}{{end}}{{end}}')" = \
  "bind|true"
dim workspace exec "$workspace_name" -- \
  docker exec "$agent_dind_container" dim-agent-dind inspect \
  --format '{{.HostConfig.Privileged}}' | grep -qx false
dim workspace exec "$workspace_name" -- \
  docker exec "$agent_dind_container" dim-agent-dind inspect \
  --format '{{json .Mounts}}' | grep -q '"Destination":"/run/docker.sock"'
! dim workspace exec "$workspace_name" -- \
  docker exec "$agent_dind_container" dim-agent-dind inspect \
  --format '{{json .Mounts}}' | grep -q /var/run/docker.sock
dim workspace exec "$workspace_name" -- docker inspect --format '{{.HostConfig.Privileged}}' \
  "$agent_dind_container" | grep -qx true
verification_stage="agent sudo contract"
dim workspace run "$workspace_name" bash -- -lc '
  test "$(id -u)" != 0
  test "$(id -un)" = dim-agent
  sudo sh -c '\''test "$(id -u)" = 0'\''
'
verification_stage="agent private Docker workload"
dim workspace run "$workspace_name" bash -- -lc '
  ! docker info --format "{{json .SecurityOptions}}" | grep -q rootless
  rm -rf /mnt/workspace-shared-dind/bind-smoke
  mkdir -m 0777 /mnt/workspace-shared-dind/bind-smoke
  printf "from-agent\n" > /mnt/workspace-shared-dind/bind-smoke/input
  docker run --rm \
    --mount type=bind,source=/mnt/workspace-shared-dind/bind-smoke,target=/shared \
    alpine:3.22 sh -c \
      "test \"\$(cat /shared/input)\" = from-agent; printf \"from-dind\\n\" > /shared/output"
  test "$(cat /mnt/workspace-shared-dind/bind-smoke/output)" = from-dind
'
verification_stage="agent typecheck"
dim workspace run "$workspace_name" bash -- -lc 'just typecheck' >/dev/null
verification_stage="agent Codex command"
test "$(dim workspace run "$workspace_name" codex -- --version)" != ""
verification_stage="agent task contract"
if dim workspace run "$workspace_name" check >/dev/null 2>&1; then
  echo "removed check task unexpectedly succeeded" >&2
  exit 1
fi
dim workspace run "$workspace_name" bash -- -lc 'just check-source' >/dev/null
if [[ "${DIM_SELF_VERIFY_AGENT:-0}" == 1 ]]; then
  verification_stage="full agent verification"
  dim workspace run "$workspace_name" bash -- -lc 'just verify agent' \
    >"$agent_verification_log" 2>&1
fi

# Every reviewed managed development ref can be published back to its matching
# canonical temporary branch without naming repositories one at a time.
verification_stage="repository publication"
dim repo publish "$project_name" >/dev/null
for repository in root development core core-development plugin-dns-cloudflare plugin-dns-cloudflare-development plugin-external-urls plugin-external-urls-development verification examples specification; do
  managed_sha="$(git ls-remote "$(dim repo url "$project_name" "$repository")" refs/heads/main | cut -f1)"
  external_sha="$(git --git-dir="$source_root/remotes/archive.git" rev-parse "refs/heads/dev/$repository")"
  test -n "$managed_sha"
  test "$managed_sha" = "$external_sha"
done

dim workspace discard "$workspace_name" --yes >/dev/null
dim project purge "$project_name" --yes >/dev/null

echo "container-self-project-smoke-ok"
