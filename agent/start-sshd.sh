#!/usr/bin/env bash
set -euo pipefail

test "$(id -u)" -eq 0
test -d /workspace
test -S /run/docker.sock

runtime_dir=/run/dim-agent
environment_file="$runtime_dir/environment"
workspace_probe="/workspace/.dim-agent-ssh-probe.$$"
home_probe="/home/dim-agent/.dim-agent-ssh-probe.$$"
tmp_probe="$TMPDIR/.dim-agent-ssh-probe.$$"
environment_temp=
cleanup() {
  rm -f "$workspace_probe" "$home_probe" "$tmp_probe"
  test -z "$environment_temp" || rm -f "$environment_temp"
}
trap cleanup EXIT

install -d -m 0755 /run/sshd
install -d -o root -g dim-agent -m 0750 "$runtime_dir"
chown -R dim-agent:dim-agent /home/dim-agent
setfacl -R -m u:dim-agent:rwX /workspace
find /workspace -type d -exec setfacl -m d:u:dim-agent:rwX {} +
setfacl -m u:dim-agent:rw /run/docker.sock

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/home/dim-agent
export DOCKER_HOST=unix:///run/docker.sock
allowed_environment=(
  PATH
  HOME
  DOCKER_HOST
  TMPDIR
  DIM_GIT_USERNAME
  DIM_GIT_TOKEN
  GIT_AUTHOR_NAME
  GIT_AUTHOR_EMAIL
  GIT_COMMITTER_NAME
  GIT_COMMITTER_EMAIL
  GIT_CONFIG_COUNT
  GIT_CONFIG_KEY_0
  GIT_CONFIG_VALUE_0
  GIT_CONFIG_KEY_1
  GIT_CONFIG_VALUE_1
  GIT_CONFIG_KEY_2
  GIT_CONFIG_VALUE_2
  GIT_TERMINAL_PROMPT
  DIM_EXTERNAL_URL_SOCKET
  DIM_EXTERNAL_URL_CONTAINERS_JSON
  DIM_AGENT_CONTROLLER_SOCKET
  DIM_QEMU_VERIFICATION_SOCKET
)
for variable in "${allowed_environment[@]}"; do
  test "${!variable+x}" = x || {
    printf 'required environment variable %s is absent\n' "$variable" >&2
    exit 1
  }
done

install -o root -g dim-agent -m 0440 /dev/null "$environment_file"
environment_temp="$(mktemp "$runtime_dir/.environment.XXXXXX")"
chown root:dim-agent "$environment_temp"
chmod 0440 "$environment_temp"
for variable in "${allowed_environment[@]}"; do
  printf 'export %s=%q\n' "$variable" "${!variable}" >>"$environment_temp"
done
mv -f "$environment_temp" "$environment_file"
environment_temp=

runuser -u dim-agent -- touch "/workspace/.dim-agent-ssh-probe.$$"
runuser -u dim-agent -- rm "/workspace/.dim-agent-ssh-probe.$$"
runuser -u dim-agent -- touch "/home/dim-agent/.dim-agent-ssh-probe.$$"
runuser -u dim-agent -- rm "/home/dim-agent/.dim-agent-ssh-probe.$$"
runuser -u dim-agent -- touch "$tmp_probe"
runuser -u dim-agent -- rm "$tmp_probe"
runuser -u dim-agent -- test -r "$environment_file"
runuser -u dim-agent -- /usr/local/bin/dim-agent-shell -c \
  'test "$HOME" = /home/dim-agent && test "$DOCKER_HOST" = unix:///run/docker.sock'
runuser -u dim-agent -- env DOCKER_HOST=unix:///run/docker.sock docker info >/dev/null

ssh-keygen -A
trap - EXIT
cleanup
exec /usr/sbin/sshd -D -e
