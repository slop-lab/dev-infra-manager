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
ssh_key="$state_root/ssh-id"
wrong_ssh_key="$state_root/wrong-ssh-id"
ssh_config="$state_root/ssh-config"
wrong_ssh_config="$state_root/wrong-ssh-config"
ssh_known_hosts="$state_root/ssh-known-hosts"
ssh_host_public_key="$state_root/ssh-host-ed25519.pub"
ssh_proxy="$state_root/dim-ssh-proxy"
ssh_alias="$workspace_name-agent"
ssh_host_fingerprint=""
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

record_self_ssh_host_key() {
  local expected_change="$1"
  local trusted_fingerprint local_fingerprint key_type key_data
  dim workspace run "$workspace_name" bash -- -lc \
    'cat /etc/ssh/ssh_host_ed25519_key.pub' >"$ssh_host_public_key"
  trusted_fingerprint="$(dim workspace run "$workspace_name" bash -- -lc \
    'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub')"
  local_fingerprint="$(ssh-keygen -lf "$ssh_host_public_key")"
  trusted_fingerprint="${trusted_fingerprint#* }"
  trusted_fingerprint="${trusted_fingerprint%% *}"
  local_fingerprint="${local_fingerprint#* }"
  local_fingerprint="${local_fingerprint%% *}"
  test "$local_fingerprint" = "$trusted_fingerprint"
  case "$expected_change" in
    initial) ;;
    rotated) test "$local_fingerprint" != "$ssh_host_fingerprint" ;;
    *) echo "unknown self-Project SSH host-key expectation: $expected_change" >&2; return 2 ;;
  esac
  ssh_host_fingerprint="$local_fingerprint"
  read -r key_type key_data _ <"$ssh_host_public_key"
  printf '%s %s %s\n' "$ssh_alias" "$key_type" "$key_data" >"$ssh_known_hosts"
  chmod 0600 "$ssh_known_hosts"
}

assert_self_ssh_session() {
  local agent_uid expected actual
  agent_uid="$(dim workspace run "$workspace_name" bash -- -lc 'id -u dim-agent')"
  test "$agent_uid" -ne 0
  expected="$(printf '%s\n' "$agent_uid" dim-agent /home/dim-agent /workspace)"
  actual="$(ssh -F "$ssh_config" "$ssh_alias" \
    'id -u; id -un; printf "%s\n" "$HOME"; cd /workspace; pwd; test -r AGENTS.md')"
  test "$actual" = "$expected"
}

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
trap cleanup EXIT
git config --file "$GIT_CONFIG_GLOBAL" user.name "DIM Self Host"
git config --file "$GIT_CONFIG_GLOBAL" user.email "dim-self-host@dim.invalid"
if [[ -n "${DIM_BIN:-}" ]]; then
  printf '#!/usr/bin/env bash\nexec %q "$@"\n' "$dim_bin" >"$ssh_proxy"
else
  printf '#!/usr/bin/env bash\nexec node %q "$@"\n' "$dim_bin" >"$ssh_proxy"
fi
chmod 0700 "$ssh_proxy"
ssh-keygen -q -t ed25519 -N '' -f "$ssh_key"
ssh-keygen -q -t ed25519 -N '' -f "$wrong_ssh_key"
cat >"$ssh_config" <<EOF
Host $ssh_alias
    HostName $ssh_alias
    User dim-agent
    IdentityFile $ssh_key
    IdentitiesOnly yes
    BatchMode yes
    RequestTTY no
    StrictHostKeyChecking yes
    UserKnownHostsFile $ssh_known_hosts
    GlobalKnownHostsFile /dev/null
    ProxyCommand "$ssh_proxy" workspace run "$workspace_name" ssh-proxy
EOF
cat >"$wrong_ssh_config" <<EOF
Host $ssh_alias
    HostName $ssh_alias
    User dim-agent
    IdentityFile $wrong_ssh_key
    IdentitiesOnly yes
    BatchMode yes
    RequestTTY no
    StrictHostKeyChecking yes
    UserKnownHostsFile $ssh_known_hosts
    GlobalKnownHostsFile /dev/null
    ProxyCommand "$ssh_proxy" workspace run "$workspace_name" ssh-proxy
EOF
chmod 0600 "$ssh_config" "$wrong_ssh_config"
mkdir -p "$DIM_PLUGIN_HOME"
printf '%s\n' '{"schemaVersion":1,"plugins":[]}' > "$DIM_PLUGIN_HOME/plugins.json"
bash "$script_dir/configure-user-backend.bash" "${DIM_SELF_WORKSPACE_BACKEND:-sysbox}"

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
  >"$workspace_creation_log" 2>&1; then
  dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-project" \
    --file .dim/docker-compose.yml ps >&2 || true
  dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-project" \
    --file .dim/docker-compose.yml logs --no-color >&2 || true
  exit 1
fi

verification_stage="workspace ready phase"
workspace_json="$(dim workspace show "$workspace_name" --json)"
container_name="$(jq -er .containerName <<<"$workspace_json")"
workspace_volume_name="$(jq -er .dockerVolumeName <<<"$workspace_json")"
test "$(jq -r .phase <<<"$workspace_json")" = ready
verification_stage="workspace repository manifest"
expected_repositories='["core","core-development","development","examples","plugin-dns-cloudflare","plugin-dns-cloudflare-development","plugin-external-urls","plugin-external-urls-development","root","specification","verification"]'
test "$(dim workspace exec "$workspace_name" -- jq -c '.repositories | keys' /run/dim/project.json)" = \
  "$expected_repositories"
verification_stage="workspace registry mirror"
dim workspace exec "$workspace_name" -- \
  docker info --format '{{json .RegistryConfig.Mirrors}}' |
  grep -Fq 'http://dim-registry-cache:5000/'
verification_stage="workspace Docker config ownership"
dim workspace exec "$workspace_name" -- sh -eu -c '
  test ! -e "$HOME/.docker" || test "$(stat -c %u "$HOME/.docker")" = "$(id -u)"
'

verify_agent_dind() {
  local agent_dind_container
  agent_dind_container="$(dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-project" \
    --file .dim/docker-compose.yml ps --quiet agent-dind)"
  test -n "$agent_dind_container"
  dim workspace exec "$workspace_name" -- \
    docker inspect --format '{{.State.Health.Status}}' "$agent_dind_container" | grep -qx healthy
  if [[ -n "${DIM_DOCKER_REGISTRY_MIRROR:-}" ]]; then
    actual_mirrors="$(dim workspace exec "$workspace_name" -- \
      docker exec "$agent_dind_container" docker info --format '{{json .RegistryConfig.Mirrors}}' |
      tr -d '\r')"
    grep -Fq "$DIM_DOCKER_REGISTRY_MIRROR" <<<"$actual_mirrors" || {
      echo "agent-dind registry mirror mismatch: expected $DIM_DOCKER_REGISTRY_MIRROR in $actual_mirrors" >&2
      return 1
    }
  fi
  dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-project" \
    --file .dim/docker-compose.yml exec --no-TTY --user root agent-dind \
    sh -eu -c '
      socket="${DOCKER_HOST#unix://}"
      test -S "$socket" || { echo "agent-dind Docker socket is missing: $socket" >&2; exit 1; }
      test -d /home/rootless/.local/share/docker || { echo "agent-dind data directory is missing" >&2; exit 1; }
      home_owner="$(stat -c %u:%g /mnt/agent-home)"
      workspace_owner="$(stat -c %u:%g /workspace)"
      test "$home_owner" = "$workspace_owner" || {
        echo "agent home owner $home_owner does not match workspace owner $workspace_owner" >&2
        exit 1
      }
      security_options="$(docker info --format "{{json .SecurityOptions}}")"
      printf "%s\n" "$security_options" | grep -q rootless || {
        echo "agent-dind is not rootless: $security_options" >&2
        exit 1
      }
      rootless_uid="$(id -u rootless)"
      workspace_uid="${workspace_owner%%:*}"
      test "$workspace_uid" = "$rootless_uid" || {
        echo "agent-dind rootless UID $rootless_uid does not match workspace UID $workspace_uid" >&2
        exit 1
      }
      test "$(stat -c %u:%g /usr/bin/newuidmap)" = 0:0
      test "$(stat -c %u:%g /usr/bin/newgidmap)" = 0:0
      test "$(stat -c %a /usr/bin/newuidmap)" = 4755
      test "$(stat -c %a /usr/bin/newgidmap)" = 4755
    '
}

verification_stage="initial agent-dind contract"
verify_agent_dind
verification_stage="workspace task TTY propagation"
tty_error="$state_root/tty-required.stderr"
if dim workspace run "$workspace_name" bash -- -lc \
  'bash /workspace/examples/features/tty-entrypoint/require-tty.bash' \
  2>"$tty_error"; then
  echo "TTY-required feature unexpectedly accepted a non-interactive task" >&2
  exit 1
fi
grep -Fqx "tty-required requires a terminal on stdin and stdout" "$tty_error"
command -v script >/dev/null
if [[ -n "${DIM_BIN:-}" ]]; then
  tty_arguments=("$dim_bin")
else
  tty_arguments=(node "$dim_bin")
fi
tty_arguments+=(workspace run "$workspace_name" bash -- -lc \
  'bash /workspace/examples/features/tty-entrypoint/require-tty.bash')
printf -v tty_command '%q ' "${tty_arguments[@]}"
tty_output="$(script --quiet --return --command "$tty_command" /dev/null </dev/null | tr -d '\r')"
grep -Fq "tty-required-ok" <<<"$tty_output"
if [[ -c /dev/kvm ]]; then
  verification_stage="agent-controlled QEMU probe"
  if ! qemu_probe_output="$(dim workspace run "$workspace_name" bash -- -lc \
    'node /workspace/project/.dim/qemu-client.mjs probe' 2>&1)"; then
    printf '%s\n' "$qemu_probe_output" >&2
    exit 1
  fi
  if ! grep -Fqx 'qemu-control-probe-ok' <<<"$qemu_probe_output"; then
    echo "agent-controlled QEMU probe did not report success:" >&2
    printf '%s\n' "$qemu_probe_output" >&2
    exit 1
  fi
  if [[ "${DIM_SELF_STOP_AFTER_QEMU_PROBE:-0}" == 1 ]]; then
    echo "agent-qemu-control-smoke-ok"
    exit 0
  fi
fi
verification_stage="workspace restart"
if ! restart_error="$(dim workspace restart "$workspace_name" 2>&1)"; then
  printf '%s\n' "$restart_error" >&2
  dim workspace show "$workspace_name" >&2 || true
  dim workspace exec "$workspace_name" -- git -C /workspace/project status --short >&2 || true
  dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-project" \
    --file .dim/docker-compose.yml ps >&2 || true
  dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-project" \
    --file .dim/docker-compose.yml logs --no-color agent-dind >&2 || true
  exit 1
fi
workspace_json="$(dim workspace show "$workspace_name" --json)"
container_name="$(jq -er .containerName <<<"$workspace_json")"
workspace_volume_name="$(jq -er .dockerVolumeName <<<"$workspace_json")"
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
fi
updated_resources="$(dim workspace resources "$workspace_name" \
  --cpus 1.25 --memory 2g --pids 1024 --json)"
test "$(jq -r .cpuCount <<<"$updated_resources")" = "1.25"
test "$(jq -r .memory <<<"$updated_resources")" = "2g"
test "$(jq -r .pidsLimit <<<"$updated_resources")" = "1024"
test "$(docker inspect "$container_name" --format \
  '{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.PidsLimit}}')" = \
  "1250000000|2147483648|2147483648|1024"
dim workspace resources "$workspace_name" \
  --cpus "$original_cpus" --memory "$original_memory" --pids "$original_pids" >/dev/null
verification_stage="workspace reviewed-file contract"
dim workspace exec "$workspace_name" -- \
  sh -c 'test -r .dim/setup.sh && test ! -x .dim/setup.sh && test -r .dim/entrypoint.sh && test ! -x .dim/entrypoint.sh && test -r .dim/docker-compose.yml && test "$DIM_GIT_BASE_URL" = "$(jq -r .gitBaseUrl "$DIM_PROJECT_MANIFEST")" && test -n "$(jq -r ".hostAliases[\"dim-gitea\"][0]" "$DIM_PROJECT_MANIFEST")"'
test "$(dim workspace show "$workspace_name" --json | jq -r .rootRef)" = "refs/heads/main"
agent_git_identity="$(dim workspace run "$workspace_name" bash -- -lc \
  'printf "%s <%s>|%s <%s>" "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL" "$GIT_COMMITTER_NAME" "$GIT_COMMITTER_EMAIL"')"
test "$agent_git_identity" = \
  "DIM Self Host <dim-self-host@dim.invalid>|DIM Self Host <dim-self-host@dim.invalid>"
verification_stage="authenticated non-root SSH authority"
dim workspace run "$workspace_name" bash -- -lc \
  "printf '%s\\n' ordinary-task >journey-self-ssh-existing"
dim workspace run "$workspace_name" bash -- -lc \
  'umask 077; mkdir -p "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; chmod 0700 "$HOME/.ssh"; chmod 0600 "$HOME/.ssh/authorized_keys"; cat >>"$HOME/.ssh/authorized_keys"' \
  <"$ssh_key.pub"
record_self_ssh_host_key initial
assert_self_ssh_session
ssh -F "$ssh_config" "$ssh_alias" 'bash -se' <<'SSH_AUTHORITY'
set -euo pipefail
test "$(id -u)" -ne 0
test "$(id -un)" = dim-agent
test "$HOME" = /home/dim-agent
test "$(cat /workspace/journey-self-ssh-existing)" = ordinary-task
printf '%s\n' ssh-overwrite >/workspace/journey-self-ssh-existing
test "$(cat /workspace/journey-self-ssh-existing)" = ssh-overwrite
rm /workspace/journey-self-ssh-existing
mkdir -p /workspace/journey-self-ssh-created/nested
touch /workspace/journey-self-ssh-created/nested/value
printf '%s\n' nested-workspace >/workspace/journey-self-ssh-created/nested/value
test "$(cat /workspace/journey-self-ssh-created/nested/value)" = nested-workspace
rm -rf /workspace/journey-self-ssh-created
touch "$HOME/journey-self-ssh-home"
printf '%s\n' persistent-home >"$HOME/journey-self-ssh-home"
test "$(cat "$HOME/journey-self-ssh-home")" = persistent-home
rm "$HOME/journey-self-ssh-home"
test "$DOCKER_HOST" = unix:///run/docker.sock
test -S /run/docker.sock
test ! -e /var/run/docker.sock
docker info --format '{{json .SecurityOptions}}' | grep -q rootless
docker run --rm alpine:3.22 true
test "$GIT_AUTHOR_NAME" = "DIM Self Host"
test "$GIT_AUTHOR_EMAIL" = dim-self-host@dim.invalid
test "$GIT_COMMITTER_NAME" = "DIM Self Host"
test "$GIT_COMMITTER_EMAIL" = dim-self-host@dim.invalid
test -n "$(git config --get credential.helper)"
test "$(git config --get-all safe.directory)" = "$(printf '/workspace\n/workspace/*')"
test "$GIT_TERMINAL_PROMPT" = 0
test -n "$DIM_GIT_TOKEN"
git ls-remote origin HEAD >/dev/null
test -S "$DIM_EXTERNAL_URL_SOCKET"
test ! -e /run/dim/controller/controller.sock
test -z "${DIM_CONTROLLER_TOKEN:-}"
curl --fail --silent --unix-socket "$DIM_EXTERNAL_URL_SOCKET" http://dim-controller/api |
  jq -e '.routes | type == "array"' >/dev/null
if test -S "$DIM_QEMU_VERIFICATION_SOCKET"; then
  node /workspace/project/.dim/qemu-client.mjs probe
  node /workspace/project/.dim/qemu-client.mjs status | jq -e '.status == "success"' >/dev/null
fi
SSH_AUTHORITY
env DIM_GIT_TOKEN=client-controlled-token ssh -F "$ssh_config" \
  -o SetEnv=DOCKER_HOST=unix:///tmp/client-controlled.sock \
  -o SendEnv=DIM_GIT_TOKEN "$ssh_alias" \
  'test "$DOCKER_HOST" = unix:///run/docker.sock; test -n "$DIM_GIT_TOKEN"; test "$DIM_GIT_TOKEN" != client-controlled-token'
if ssh -F "$ssh_config" -o User=root "$ssh_alias" true >/dev/null 2>&1; then
  echo "SSH unexpectedly accepted root login" >&2
  exit 1
fi
if ssh -F "$wrong_ssh_config" "$ssh_alias" true >/dev/null 2>&1; then
  echo "SSH unexpectedly accepted an unprovisioned key" >&2
  exit 1
fi
if ssh -F "$ssh_config" \
  -o PubkeyAuthentication=no -o PasswordAuthentication=yes \
  -o PreferredAuthentications=password -o NumberOfPasswordPrompts=0 \
  "$ssh_alias" true >/dev/null 2>&1; then
  echo "SSH unexpectedly accepted password-only authentication" >&2
  exit 1
fi
outer_ssh_port="$(docker port "$container_name" 22/tcp 2>/dev/null || true)"
test -z "$outer_ssh_port"
agent_dind_container="$(dim workspace exec "$workspace_name" -- \
  docker compose --project-name "dim-project" --file .dim/docker-compose.yml ps --quiet agent-dind)"
nested_ssh_port="$(dim workspace exec "$workspace_name" -- docker exec "$agent_dind_container" \
  dim-agent-dind docker port dim-agent 22/tcp 2>/dev/null || true)"
test -z "$nested_ssh_port"
verification_stage="agent identity"
workspace_owner_uid="$(dim workspace exec "$workspace_name" -- stat -c %u /workspace)"
agent_uid="$(dim workspace run "$workspace_name" bash -- -lc 'id -u')"
test "$agent_uid" = 0
verification_stage="agent KVM isolation"
dim workspace run "$workspace_name" bash -- -lc \
  'test ! -e /dev/kvm && test ! -r /dev/kvm && test ! -w /dev/kvm'
verification_stage="agent base toolchain and home persistence"
if [[ -n "${DIM_SELF_EXPECT_AGENT_UID:-}" ]]; then
  test "$workspace_owner_uid" = "$DIM_SELF_EXPECT_AGENT_UID"
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
  docker compose --project-name "dim-project" \
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
verification_stage="agent username contract"
test "$(dim workspace run "$workspace_name" bash -- -lc 'id -un')" = root
verification_stage="agent rootless UID mapping contract"
dim workspace run "$workspace_name" bash -- -lc \
  'test "$(id -u)" = 0 && test "$(stat -c %u /workspace)" = 0'
test "$(dim workspace exec "$workspace_name" -- docker exec "$agent_dind_container" id -u rootless)" = \
  "$workspace_owner_uid"
verification_stage="agent private Docker workload"
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
verification_stage="agent typecheck"
dim workspace run "$workspace_name" bash -- -lc 'just typecheck' >/dev/null
verification_stage="agent Codex command"
test "$(dim workspace run "$workspace_name" codex -- --version)" != ""
verification_stage="agent task contract"
if dim workspace run "$workspace_name" check >/dev/null 2>&1; then
  echo "removed check task unexpectedly succeeded" >&2
  exit 1
fi
dim workspace run "$workspace_name" bash -- -lc \
  "DIM_EXPECT_ARCHIVE_URL='$source_root/remotes/archive.git' just check-source" >/dev/null
if [[ "${DIM_SELF_VERIFY_AGENT:-0}" == 1 ]]; then
  verification_stage="full agent verification"
  dim workspace run "$workspace_name" bash -- -lc \
    "DIM_EXPECT_ARCHIVE_URL='$source_root/remotes/archive.git' just verify agent" \
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
