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
