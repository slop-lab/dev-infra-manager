#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
dockerfile="$repo_root/agent/Dockerfile"
startup="$repo_root/agent/start-sshd.sh"
shell_bridge="$repo_root/agent/dim-agent-shell"

require_source() {
  local file="$1"
  local expected="$2"

  grep -Fqx -- "$expected" "$file" >/dev/null || {
    printf 'expected %s in %s\n' "$expected" "$file" >&2
    exit 1
  }
}

require_fragment() {
  local file="$1"
  local expected="$2"

  grep -Fq -- "$expected" "$file" || {
    printf 'expected %s in %s\n' "$expected" "$file" >&2
    exit 1
  }
}

reject_fragment() {
  local file="$1"
  local forbidden="$2"

  if grep -Fq -- "$forbidden" "$file"; then
    printf 'forbidden %s in %s\n' "$forbidden" "$file" >&2
    exit 1
  fi
}

require_pattern() {
  local file="$1"
  local expected="$2"

  grep -Eq -- "$expected" "$file" || {
    printf 'expected pattern %s in %s\n' "$expected" "$file" >&2
    exit 1
  }
}

require_source "$dockerfile" 'ARG DIM_AGENT_UID=1000'
require_fragment "$dockerfile" 'test "$DIM_AGENT_UID" -ne 0'
require_fragment "$dockerfile" 'existing_group="$(getent group "$DIM_AGENT_UID" | cut -d: -f1)"'
require_fragment "$dockerfile" 'groupmod --new-name dim-agent "$existing_group"'
require_fragment "$dockerfile" 'groupadd --gid "$DIM_AGENT_UID" dim-agent'
require_fragment "$dockerfile" 'existing_user="$(getent passwd "$DIM_AGENT_UID" | cut -d: -f1)"'
require_fragment "$dockerfile" 'usermod --gid dim-agent --home /home/dim-agent --shell /usr/local/bin/dim-agent-shell dim-agent'
require_fragment "$dockerfile" 'usermod --login dim-agent --gid dim-agent --home /home/dim-agent --move-home --shell /usr/local/bin/dim-agent-shell "$existing_user"'
require_fragment "$dockerfile" 'useradd --uid "$DIM_AGENT_UID" --gid dim-agent --home-dir /home/dim-agent --create-home --shell /usr/local/bin/dim-agent-shell dim-agent'
require_pattern "$dockerfile" '(passwd -d|usermod --unlock) dim-agent'
if ! awk '/apt-get install/,/rm -f \/etc\/ssh/' "$dockerfile" | grep -qw acl; then
  printf 'expected acl package in %s\n' "$dockerfile" >&2
  exit 1
fi
require_fragment "$dockerfile" "'PermitRootLogin no'"
require_fragment "$dockerfile" "'PubkeyAuthentication yes'"
require_fragment "$dockerfile" "'AuthenticationMethods publickey'"
require_fragment "$dockerfile" "'PasswordAuthentication no'"
require_fragment "$dockerfile" "'PermitEmptyPasswords no'"
require_fragment "$dockerfile" "'KbdInteractiveAuthentication no'"
require_fragment "$dockerfile" "'PermitUserEnvironment no'"
require_fragment "$dockerfile" "'AllowUsers dim-agent'"
require_fragment "$dockerfile" "'AuthorizedKeysFile /home/dim-agent/.ssh/authorized_keys'"
require_pattern "$dockerfile" '>[[:space:]]*/etc/ssh/sshd_config$'
reject_fragment "$dockerfile" 'AcceptEnv'
reject_fragment "$dockerfile" 'Include'
reject_fragment "$dockerfile" '/etc/ssh/sshd_config.d/'
reject_fragment "$dockerfile" 'sudo'
reject_fragment "$dockerfile" 'chmod u+s'
reject_fragment "$dockerfile" 'chmod 4'
reject_fragment "$dockerfile" 'EXPOSE 22'
require_source "$dockerfile" 'COPY agent/dim-agent-shell /usr/local/bin/dim-agent-shell'
require_fragment "$dockerfile" 'rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub'
require_source "$startup" 'runtime_dir=/run/dim-agent'
require_source "$startup" 'install -d -o root -g dim-agent -m 0750 "$runtime_dir"'
require_source "$startup" 'test -d /workspace'
require_source "$startup" 'test -S /run/docker.sock'
require_source "$startup" 'setfacl -R -m u:dim-agent:rwX /workspace'
require_source "$startup" 'find /workspace -type d -exec setfacl -m d:u:dim-agent:rwX {} +'
require_source "$startup" 'setfacl -m u:dim-agent:rw /run/docker.sock'
require_source "$startup" 'chown -R dim-agent:dim-agent /home/dim-agent'
reject_fragment "$startup" 'chown -R dim-agent:dim-agent /workspace'
reject_fragment "$dockerfile" '/var/run/docker.sock'
reject_fragment "$startup" '/var/run/docker.sock'
require_source "$startup" 'environment_file="$runtime_dir/environment"'
require_source "$startup" 'install -o root -g dim-agent -m 0440 /dev/null "$environment_file"'
require_source "$startup" 'allowed_environment=('
for variable in \
  DOCKER_HOST \
  DIM_GIT_USERNAME DIM_GIT_TOKEN \
  GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL \
  GIT_CONFIG_COUNT \
  GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 \
  GIT_CONFIG_KEY_1 GIT_CONFIG_VALUE_1 \
  GIT_CONFIG_KEY_2 GIT_CONFIG_VALUE_2 \
  GIT_TERMINAL_PROMPT \
  DIM_EXTERNAL_URL_SOCKET DIM_EXTERNAL_URL_CONTAINERS_JSON \
  DIM_QEMU_VERIFICATION_SOCKET; do
  require_fragment "$startup" "$variable"
done
require_pattern "$startup" 'runuser -u dim-agent -- (touch|sh -c .*touch).*\/workspace\/'
require_pattern "$startup" 'runuser -u dim-agent -- (rm|sh -c .*rm).*\/workspace\/'
require_pattern "$startup" 'runuser -u dim-agent -- (touch|sh -c .*touch).*\/home\/dim-agent\/'
require_pattern "$startup" 'runuser -u dim-agent -- (rm|sh -c .*rm).*\/home\/dim-agent\/'
require_source "$startup" 'runuser -u dim-agent -- test -r "$environment_file"'
require_source "$startup" 'runuser -u dim-agent -- env DOCKER_HOST=unix:///run/docker.sock docker info >/dev/null'
require_source "$shell_bridge" '. /run/dim-agent/environment'
require_source "$shell_bridge" 'case "$#" in'
require_source "$shell_bridge" '  0) exec /bin/bash --login ;;'
require_source "$shell_bridge" '  2)'
require_source "$shell_bridge" '    test "$1" = -c || exit 2'
require_source "$shell_bridge" '    exec /bin/bash -c "$2"'
require_source "$shell_bridge" '    ;;'
require_source "$shell_bridge" '  *) exit 2 ;;'
require_source "$shell_bridge" 'esac'
reject_fragment "$shell_bridge" 'env |'
reject_fragment "$shell_bridge" 'printenv'
require_source "$startup" 'ssh-keygen -A'
require_source "$startup" 'exec /usr/sbin/sshd -D -e'
require_source "$dockerfile" 'CMD ["/usr/local/bin/start-sshd"]'

if grep -Eq '^(COPY|ADD)[[:space:]].*(authorized_keys|id_(rsa|ed25519)|/home)' "$dockerfile"; then
  printf 'agent image must not contain secret-bearing home or SSH artifacts\n' >&2
  exit 1
fi

if grep -Fq 'getent passwd root' "$dockerfile"; then
  printf 'root passwd entry must not be repurposed for dim-agent\n' >&2
  exit 1
fi
