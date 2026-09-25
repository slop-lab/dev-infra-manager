#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
# shellcheck source=lib/test-registry-mirror.bash
source "$script_dir/lib/test-registry-mirror.bash"
source "$script_dir/lib/registry-cache-routing.bash"
source "$script_dir/lib/registry-cache-routing-journey.bash"
source "$script_dir/lib/stateful-development-flow.bash"
source "$script_dir/lib/private-dind-assertions.bash"

for required_command in ssh ssh-keygen sha256sum; do
  command -v "$required_command" >/dev/null || {
    printf 'unavailable: full-development-flow requires %s\n' "$required_command" >&2
    exit 2
  }
done

suffix="$PPID-$$"
project_name="full-flow-$suffix"
workspace_name="full-flow-dev-$suffix"
dim_stateful_initialize_work_tree "$repo_root"
ordinary_org_name="ordinary-writer-denial-$suffix"
ordinary_org_created=false
ordinary_org_response="$work_dir/ordinary-org-response.json"
backup="$work_dir/agent-home.tar.gz"
ssh_key="$work_dir/ssh-id"
wrong_ssh_key="$work_dir/wrong-ssh-id"
ssh_config="$work_dir/ssh-config"
wrong_ssh_config="$work_dir/wrong-ssh-config"
ssh_known_hosts="$work_dir/ssh-known-hosts"
ssh_host_public_key="$work_dir/ssh-host-ed25519.pub"
ssh_alias="$workspace_name-agent"
ssh_workspace_sentinel="ssh-workspace-$suffix"
ssh_host_fingerprint=""
dim_cli="$repo_root/core/packages/cli/dist/cli.js"
dim_bin="$work_dir/dim"
controller_pid=""

export DIM_STATE_ROOT="$state_root"
export DIM_CONFIG_PATH="$work_dir/config/dim.json"
export DIM_DATA_HOME="$work_dir/data"
export DIM_CONTROLLER_SOCKET="$controller_socket"
export DIM_AGENT_CONTROLLER_SOCKET="$agent_controller_socket"
export DIM_ADMIN_CONTROLLER_SOCKET="$admin_socket"
export XDG_RUNTIME_DIR="$controller_runtime_dir"
export GIT_CONFIG_GLOBAL="$work_dir/host.gitconfig"
git config --file "$GIT_CONFIG_GLOBAL" user.name "Full Flow Host"
git config --file "$GIT_CONFIG_GLOBAL" user.email "full-flow@dim.invalid"

dim() { node "$dim_cli" "$@"; }

workspace_compose() {
  dim workspace exec "$workspace_name" -- sh -eu -c '
    cd "$DIM_PROJECT_ROOT"
    exec docker compose --project-name dim-project \
      --file "$DIM_PROJECT_ROOT/.dim/docker-compose.yml" "$@"
  ' sh "$@"
}

gitea_api_status() {
  local role="$1" method="$2" path="$3" response_file="$4" body="${5:-}"
  local credentials username password xtrace_enabled=false
  [[ $- == *x* ]] && { xtrace_enabled=true; set +x; }
  credentials="$(docker exec dim-gitea cat /data/dim/credentials.json)"
  case "$role" in
    admin)
      username="$(jq -er .adminUsername <<<"$credentials")"
      password="$(jq -er .adminPassword <<<"$credentials")"
      ;;
    writer)
      username="$(jq -er .writerUsername <<<"$credentials")"
      password="$(jq -er .writerPassword <<<"$credentials")"
      ;;
    *)
      echo "unknown Gitea API role: $role" >&2
      return 2
      ;;
  esac
  local -a request=(
    --silent --show-error
    --user "$username:$password"
    --request "$method"
    --output "$response_file"
    --write-out '%{http_code}'
  )
  if [[ -n "$body" ]]; then
    request+=(--header 'Content-Type: application/json' --data-binary "$body")
  fi
  curl "${request[@]}" "http://127.0.0.1:${DIM_GITEA_PORT:-3300}/api/v1$path"
  unset credentials username password request
  [[ "$xtrace_enabled" == true ]] && set -x
  return 0
}

cleanup_ordinary_org() {
  local cleanup_status
  [[ "$ordinary_org_created" == true ]] || return 0
  cleanup_status="$(gitea_api_status admin DELETE "/orgs/$ordinary_org_name" \
    "$ordinary_org_response")" || {
    echo "failed to clean up unexpectedly created organization '$ordinary_org_name'" >&2
    return 1
  }
  case "$cleanup_status" in
    2??) ordinary_org_created=false ;;
    *)
      echo "failed to clean up unexpectedly created organization '$ordinary_org_name': HTTP $cleanup_status" >&2
      return 1
      ;;
  esac
}

return_status() { return "$1"; }

cleanup_with_ordinary_org() {
  local status=$?
  cleanup_ordinary_org || status=1
  set +e
  return_status "$status"
  cleanup
}

record_ssh_host_key() {
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
    same) test "$local_fingerprint" = "$ssh_host_fingerprint" ;;
    rotated) test "$local_fingerprint" != "$ssh_host_fingerprint" ;;
    *) echo "unknown SSH host-key expectation: $expected_change" >&2; return 2 ;;
  esac
  ssh_host_fingerprint="$local_fingerprint"
  read -r key_type key_data _ <"$ssh_host_public_key"
  printf '%s %s %s\n' "$ssh_alias" "$key_type" "$key_data" >"$ssh_known_hosts"
  chmod 0600 "$ssh_known_hosts"
  printf '[full-development-flow] trusted SSH host fingerprint: %s\n' "$ssh_host_fingerprint"
}

assert_ssh_session() {
  local project_task_uid expected actual
  project_task_uid="$(dim workspace run "$workspace_name" bash -- -lc 'id -u')"
  test "$project_task_uid" -ne 0
  expected="$(printf '%s\n' "$project_task_uid" dim-agent /home/dim-agent /workspace)"
  actual="$(ssh -F "$ssh_config" "$ssh_alias" \
    'id -u; id -un; printf "%s\n" "$HOME"; cd /workspace; pwd; test -r ops/secret-service.sh')"
  test "$actual" = "$expected"
}
trap cleanup_with_ordinary_org EXIT
dim_stateful_assert_shared_paths

cd "$repo_root"
echo "[full-development-flow] prepare reviewed repositories and controller"
just build-packages
just build-workspace-image
printf '#!/usr/bin/env bash\nexec node %q "$@"\n' "$dim_cli" >"$dim_bin"
chmod 0700 "$dim_bin"
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
    ProxyCommand "$dim_bin" workspace run "$workspace_name" ssh-proxy
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
    ProxyCommand "$dim_bin" workspace run "$workspace_name" ssh-proxy
EOF
chmod 0600 "$ssh_config" "$wrong_ssh_config"
bash "$script_dir/configure-user-backend.bash" "${DIM_EXAMPLE_WORKSPACE_BACKEND:-sysbox}"
bash examples/projects/full-development-flow/create-repositories.bash "$repositories" >/dev/null
dim_apply_test_registry_mirror "$repositories/root"
install_stateful_setup_hook
git -C "$repositories/root" add .dim
git -C "$repositories/root" commit -m "add stateful journey hooks" >/dev/null

start_controller
DIM_BIN="$dim_bin" bash examples/projects/full-development-flow/register-project.bash \
  "$project_name" "$repositories" >/dev/null

echo "[full-development-flow] deny ordinary-writer organization creation"
ordinary_org_status="$(gitea_api_status writer POST /orgs "$ordinary_org_response" \
  "$(jq -cn --arg name "$ordinary_org_name" '{username:$name,visibility:"private"}')")"
case "$ordinary_org_status" in
  2??)
    ordinary_org_created=true
    cleanup_ordinary_org || true
    echo "ordinary writer unexpectedly created organization '$ordinary_org_name'" >&2
    exit 1
    ;;
  403)
    jq -e 'type == "object"' "$ordinary_org_response" >/dev/null || {
      echo "ordinary-writer organization denial returned a non-JSON response" >&2
      exit 1
    }
    ;;
  *)
    echo "ordinary-writer organization creation returned unexpected HTTP $ordinary_org_status" >&2
    exit 1
    ;;
esac

echo "[full-development-flow] create a profiled, resource-bounded workspace"
if ! dim workspace create "$project_name" "$workspace_name" \
  --profile documentation --cpus 2 --memory 3g --pids 768; then
  diagnose_workspace_setup
  exit 1
fi
workspace_json="$(dim workspace show "$workspace_name" --json)"
container_name="$(jq -er .containerName <<<"$workspace_json")"
docker_volume_name="$(jq -er .dockerVolumeName <<<"$workspace_json")"
compose_name=dim-project
test "$(jq -c .profiles <<<"$workspace_json")" = '["documentation"]'
test "$(jq -r .cpuCount <<<"$workspace_json")" = 2
test "$(jq -r .memory <<<"$workspace_json")" = 3g
test "$(jq -r .pidsLimit <<<"$workspace_json")" = 768
dim workspace run "$workspace_name" bash -- -lc '! command -v opencode >/dev/null 2>&1'
test "$(dim workspace run "$workspace_name" bash -- -lc 'printf provider-neutral-bash-ok')" = \
  "provider-neutral-bash-ok"
test "$(dim workspace run "$workspace_name" bash -- -lc 'id -u')" -ne "0"
test "$(dim workspace run "$workspace_name" bash -- -lc 'sudo -n id -u')" = "0"
dim workspace run "$workspace_name" bash -- -lc 'getent hosts dim-gitea >/dev/null'
dim workspace run "$workspace_name" bash -- -lc 'git ls-remote origin HEAD >/dev/null'
workspace_compose exec --no-TTY agent-dind docker inspect dim-documentation-preview >/dev/null
workspace_compose exec --no-TTY agent-dind docker image inspect alpine:3.22 >/dev/null
dim workspace run "$workspace_name" bash -- -lc \
  'docker info --format "{{json .SecurityOptions}}" | grep -q rootless; docker run --rm alpine:3.22 true'
dim_cache_routing_workspace_routes "$workspace_name" "$compose_name"

archive_restart_backup="$work_dir/archive-restart.tar.gz"
dim workspace run "$workspace_name" bash -- -lc \
  'umask 077; printf "archive-restart\n" >"$HOME/archive-restart"; chmod 0640 "$HOME/archive-restart"'
dim workspace run "$workspace_name" backup >"$archive_restart_backup"
gzip -t "$archive_restart_backup"
test "$(workspace_compose exec --no-TTY agent-dind docker inspect \
  --format '{{.State.Running}}' dim-agent)" = true
dim workspace run "$workspace_name" bash -- -lc 'rm "$HOME/archive-restart"'
dim workspace run "$workspace_name" restore <"$archive_restart_backup"
test "$(dim workspace run "$workspace_name" bash -- -lc 'cat "$HOME/archive-restart"')" = archive-restart
test "$(dim workspace run "$workspace_name" bash -- -lc 'stat -c %a "$HOME/archive-restart"')" = 640
test "$(workspace_compose exec --no-TTY agent-dind docker inspect \
  --format '{{.State.Running}}' dim-agent)" = true

dim workspace update "$workspace_name" --profile documentation --profile secure >/dev/null
test "$(dim workspace show "$workspace_name" --json | jq -c .profiles)" = '["documentation","secure"]'
secure_container="$(workspace_compose ps --all --quiet secure-dind)"
test -n "$secure_container"
test "$(dim workspace exec "$workspace_name" -- docker inspect "$secure_container" --format '{{.State.Running}}')" = true
(
  docker() { dim workspace exec "$workspace_name" -- docker "$@"; }
  dim_assert_private_dind_unix_only "$secure_container" /run/dim-secure-dind/docker.sock
)
workspace_compose exec --no-TTY agent-dind docker inspect dim-documentation-preview >/dev/null
dim workspace update "$workspace_name" --profile documentation >/dev/null
test "$(dim workspace exec "$workspace_name" -- docker inspect "$secure_container" --format '{{.State.Running}}')" = false
dim workspace update "$workspace_name" --clear-profiles >/dev/null
test "$(dim workspace show "$workspace_name" --json | jq -c .profiles)" = '[]'
if workspace_compose exec --no-TTY agent-dind docker inspect dim-documentation-preview >/dev/null 2>&1; then
  echo "documentation preview survived profile clearing" >&2
  exit 1
fi
dim workspace update "$workspace_name" --profile documentation >/dev/null

echo "[full-development-flow] connect through key-only OpenSSH ProxyCommand"
dim workspace run "$workspace_name" bash -- -lc \
  "printf '%s\\n' ordinary-task >journey-ssh-existing"
dim workspace run "$workspace_name" bash -- -lc \
  'umask 077; mkdir -p "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; chmod 0700 "$HOME/.ssh"; chmod 0600 "$HOME/.ssh/authorized_keys"; cat >>"$HOME/.ssh/authorized_keys"' \
  <"$ssh_key.pub"
record_ssh_host_key initial
assert_ssh_session
ssh -F "$ssh_config" "$ssh_alias" 'bash -se' <<'SSH_AUTHORITY'
set -euo pipefail
test "$(id -u)" -ne 0
test "$(id -un)" = dim-agent
test "$HOME" = /home/dim-agent
test "$(getent passwd dim-agent | cut -d: -f7)" = /usr/local/bin/dim-agent-shell
test "$(stat -c '%U:%G:%a' /run/dim-agent/environment)" = root:dim-agent:440
test ! -w /run/dim-agent/environment
expected_bridge_variables="$(printf '%s\n' \
  PATH HOME DOCKER_HOST DIM_CONTROLLER_SOCKET DIM_GIT_USERNAME DIM_GIT_TOKEN \
  GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL \
  GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 GIT_CONFIG_KEY_1 \
  GIT_CONFIG_VALUE_1 GIT_CONFIG_KEY_2 GIT_CONFIG_VALUE_2 GIT_TERMINAL_PROMPT)"
test "$(sed -n 's/^export \([^=]*\)=.*/\1/p' /run/dim-agent/environment)" = \
  "$expected_bridge_variables"
getfacl -cp /workspace | grep -qx 'user:dim-agent:rwx'
getfacl -cp /workspace | grep -qx 'default:user:dim-agent:rwx'
test "$(cat /workspace/journey-ssh-existing)" = ordinary-task
printf '%s\n' ssh-overwrite >/workspace/journey-ssh-existing
test "$(cat /workspace/journey-ssh-existing)" = ssh-overwrite
rm /workspace/journey-ssh-existing
mkdir -p /workspace/journey-ssh-created/nested
touch /workspace/journey-ssh-created/nested/value
printf '%s\n' nested-workspace >/workspace/journey-ssh-created/nested/value
test "$(cat /workspace/journey-ssh-created/nested/value)" = nested-workspace
rm -rf /workspace/journey-ssh-created
touch "$HOME/journey-ssh-home"
printf '%s\n' persistent-home >"$HOME/journey-ssh-home"
test "$(cat "$HOME/journey-ssh-home")" = persistent-home
rm "$HOME/journey-ssh-home"
test "$DOCKER_HOST" = unix:///run/dim-agent-dind/docker.sock
test -S /run/dim-agent-dind/docker.sock
getfacl -cp /run/dim-agent-dind/docker.sock | grep -qx 'user:dim-agent:rw-'
getfacl -cp /run/dim-agent-dind/docker.sock | grep -qx 'other::---'
test ! -e /var/run/docker.sock
docker info --format '{{json .SecurityOptions}}' | grep -q rootless
docker run --rm alpine:3.22 true
test "$GIT_AUTHOR_NAME" = "Full Flow Host"
test "$GIT_AUTHOR_EMAIL" = full-flow@dim.invalid
test "$GIT_COMMITTER_NAME" = "Full Flow Host"
test "$GIT_COMMITTER_EMAIL" = full-flow@dim.invalid
test "$GIT_CONFIG_COUNT" = 3
test "$GIT_CONFIG_KEY_0" = credential.helper
test "$GIT_CONFIG_VALUE_0" = '!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f'
test "$GIT_CONFIG_KEY_1" = safe.directory
test "$GIT_CONFIG_VALUE_1" = /workspace
test "$GIT_CONFIG_KEY_2" = safe.directory
test "$GIT_CONFIG_VALUE_2" = '/workspace/*'
test "$GIT_TERMINAL_PROMPT" = 0
test -n "$(git config --get credential.helper)"
test "$(git config --get-all safe.directory)" = "$(printf '/workspace\n/workspace/*')"
test -n "$DIM_GIT_TOKEN"
GIT_TERMINAL_PROMPT=0 git -C /workspace ls-remote origin HEAD >/dev/null
test -S "$DIM_CONTROLLER_SOCKET"
test ! -e /run/dim/controller/controller.sock
test -z "${DIM_CONTROLLER_TOKEN:-}"
curl --fail --silent --unix-socket "$DIM_CONTROLLER_SOCKET" http://dim-controller/api |
  jq -e '.routes | type == "array"' >/dev/null
if test -n "${DIM_EXTERNAL_URL_SOCKET:-}" && test -S "$DIM_EXTERNAL_URL_SOCKET"; then
  curl --fail --silent --unix-socket "$DIM_EXTERNAL_URL_SOCKET" http://dim-controller/api |
    jq -e '.routes | type == "array"' >/dev/null
fi
if test -n "${DIM_QEMU_VERIFICATION_SOCKET:-}" && test -S "$DIM_QEMU_VERIFICATION_SOCKET"; then
  node /workspace/project/.dim/qemu-client.mjs probe
  node /workspace/project/.dim/qemu-client.mjs status | jq -e '.status == "success"' >/dev/null
fi
SSH_AUTHORITY
env DIM_GIT_TOKEN=client-controlled-token ssh -F "$ssh_config" \
  -o SetEnv=DOCKER_HOST=unix:///tmp/client-controlled.sock \
  -o SendEnv=DIM_GIT_TOKEN "$ssh_alias" \
  'test "$DOCKER_HOST" = unix:///run/dim-agent-dind/docker.sock; test -n "$DIM_GIT_TOKEN"; test "$DIM_GIT_TOKEN" != client-controlled-token'
if ssh -F "$ssh_config" -o User=root "$ssh_alias" true >/dev/null 2>&1; then
  echo "SSH unexpectedly accepted root login" >&2
  exit 1
fi
ssh_payload="$work_dir/ssh-payload"
ssh_round_trip="$work_dir/ssh-round-trip"
printf 'ssh-payload-%s\nsecond-line-with-tabs\t%s\n' "$suffix" "$ssh_workspace_sentinel" >"$ssh_payload"
ssh -F "$ssh_config" "$ssh_alias" 'cat >"$HOME/journey-ssh-payload"' <"$ssh_payload"
test "$(ssh -F "$ssh_config" "$ssh_alias" 'sha256sum "$HOME/journey-ssh-payload" | cut -d " " -f 1')" = \
  "$(sha256sum "$ssh_payload" | cut -d ' ' -f 1)"
ssh -F "$ssh_config" "$ssh_alias" 'cat "$HOME/journey-ssh-payload"' >"$ssh_round_trip"
cmp "$ssh_payload" "$ssh_round_trip"
ssh -F "$ssh_config" "$ssh_alias" 'rm "$HOME/journey-ssh-payload"'
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
dind_container="$(workspace_compose ps --quiet agent-dind)"
test -n "$dind_container"
(
  docker() { dim workspace exec "$workspace_name" -- docker "$@"; }
  dim_assert_private_dind_unix_only "$dind_container" /run/dim-agent-dind/docker.sock
)
agent_container="$(dim workspace exec "$workspace_name" -- \
  docker exec "$dind_container" docker inspect --format '{{.Id}}' dim-agent)"
test -n "$agent_container"
test "$(dim workspace exec "$workspace_name" -- docker exec "$dind_container" docker inspect dim-agent \
  --format '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Type}}|{{.RW}}|{{.Source}}{{end}}{{end}}')" = \
  "bind|true|/workspace"
nested_ssh_port="$(dim workspace exec "$workspace_name" -- docker exec "$dind_container" \
  docker port dim-agent 22/tcp 2>/dev/null || true)"
test -z "$nested_ssh_port"
echo "[full-development-flow] preserve Project-owned work across reviewed restart"
dim workspace run "$workspace_name" bash -- -lc \
  'printf "persistent-home\n" >"$HOME/journey-home"'
dim workspace exec "$workspace_name" -- sh -c \
  'cd "$DIM_WORKSPACE_DATA/project"; printf "# dirty journey probe\n" >>ops/secret-service.sh; printf "untracked\n" >journey-untracked'
if ! dim workspace restart "$workspace_name" >/dev/null; then
  diagnose_workspace_setup
  exit 1
fi
dim workspace exec "$workspace_name" -- sh -c \
  'cd "$DIM_WORKSPACE_DATA/project"; grep -q "dirty journey probe" ops/secret-service.sh; test -f journey-untracked'

review="$work_dir/review"
dim x git clone --quiet "$(dim repo url "$project_name" root)" "$review"
git -C "$review" config user.name "Full Flow Reviewer"
git -C "$review" config user.email "reviewer@dim.invalid"
printf 'reviewed-v2\n' >"$review/reviewed-version.txt"
git -C "$review" add reviewed-version.txt
git -C "$review" commit -m "review development environment update" >/dev/null
dim x git -C "$review" push origin main >/dev/null
if ! dim workspace restart "$workspace_name" >/dev/null; then
  diagnose_workspace_setup
  exit 1
fi
test "$(dim workspace run "$workspace_name" bash -- -lc 'cat reviewed-version.txt')" = reviewed-v1
test "$(dim workspace run "$workspace_name" bash -- -lc 'cat "$HOME/journey-home"')" = persistent-home
test "$(dim workspace run "$workspace_name" bash -- -lc 'id -u')" -ne "0"
test "$(dim workspace run "$workspace_name" bash -- -lc 'sudo -n id -u')" = "0"
dim workspace run "$workspace_name" bash -- -lc 'getent hosts dim-gitea >/dev/null'
dim workspace run "$workspace_name" bash -- -lc 'git ls-remote origin HEAD >/dev/null'
record_ssh_host_key rotated
assert_ssh_session

echo "[full-development-flow] survive stop/start and controller replacement"
stop_start_workspace
record_ssh_host_key rotated
assert_ssh_session
restart_externally_stopped_workspace
record_ssh_host_key rotated
assert_ssh_session
replace_controller
record_ssh_host_key same
assert_ssh_session

echo "[full-development-flow] preserve volumes across host shutdown and restore"
volumes_before="$(docker volume ls --filter label=dim.managed=true --format '{{.Name}}' | sort)"
dim workspace exec "$workspace_name" -- touch /tmp/dim-stateful-setup-error
dim host shutdown >/dev/null
assert_host_stopped "$volumes_before"
if dim host start >/dev/null 2>&1; then
  echo "host restore unexpectedly succeeded with an injected setup failure" >&2
  exit 1
fi
test "$(dim host status --json | jq -r .phase)" = error
test -f "$state_root/projects/$project_name.json"
test -f "$state_root/workspaces/$workspace_name.json"
test "$(jq -r .phase "$state_root/workspaces/$workspace_name.json")" = setup-error
test "$(jq -c .resumeWorkspaces "$state_root/host.json")" = "[\"$workspace_name\"]"
test "$(jq -c .restartCiRunners "$state_root/host.json")" = '[]'
test "$(jq -c .resumeManagedContainers "$state_root/host.json")" = '[]'
test "$(docker volume ls --filter label=dim.managed=true --format '{{.Name}}' | sort)" = "$volumes_before"
test "$(docker exec "$container_name" docker run --rm \
  --volume "${compose_name}_agent-home:/home:ro" alpine:3.22 cat /home/journey-home)" = persistent-home
dim host start >/dev/null
assert_host_restored
record_ssh_host_key rotated
assert_ssh_session

echo "[full-development-flow] recover from setup-error"
recover_setup_error
record_ssh_host_key rotated
assert_ssh_session

echo "[full-development-flow] backup, discard, recreate, and restore agent home"
workspace_json="$(dim workspace show "$workspace_name" --json)"
container_name="$(jq -er .containerName <<<"$workspace_json")"
docker_volume_name="$(jq -er .dockerVolumeName <<<"$workspace_json")"
dim workspace run "$workspace_name" backup >"$backup"
gzip -t "$backup"
dim workspace discard "$workspace_name" --yes >/dev/null
test ! -e "$state_root/workspaces/$workspace_name.json"
test -z "$(docker ps -aq --filter "name=^/$container_name$")"
test -z "$(docker volume ls -q --filter "name=^$docker_volume_name$")"

dim workspace create "$project_name" "$workspace_name" \
  --profile documentation --cpus 2 --memory 3g --pids 768
workspace_json="$(dim workspace show "$workspace_name" --json)"
container_name="$(jq -er .containerName <<<"$workspace_json")"
docker_volume_name="$(jq -er .dockerVolumeName <<<"$workspace_json")"
record_ssh_host_key rotated
dim workspace run "$workspace_name" restore <"$backup"
test "$(dim workspace run "$workspace_name" bash -- -lc 'cat "$HOME/journey-home"')" = persistent-home
test "$(dim workspace run "$workspace_name" bash -- -lc 'cat reviewed-version.txt')" = reviewed-v2
assert_ssh_session
dim_cache_routing_workspace_outage "$workspace_name"
dim workspace discard "$workspace_name" --yes >/dev/null
test ! -e "$state_root/workspaces/$workspace_name.json"
test -z "$(docker ps -aq --filter "name=^/$container_name$")"
test -z "$(docker volume ls -q --filter "name=^$docker_volume_name$")"

dim project purge "$project_name" --yes >/dev/null
test ! -e "$state_root/projects/$project_name.json"
echo "stateful-development-flow-smoke-ok"
