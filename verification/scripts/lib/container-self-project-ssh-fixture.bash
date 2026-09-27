ssh_key="$state_root/ssh-id"
wrong_ssh_key="$state_root/wrong-ssh-id"
ssh_config="$state_root/ssh-config"
wrong_ssh_config="$state_root/wrong-ssh-config"
ssh_known_hosts="$state_root/ssh-known-hosts"
ssh_host_public_key="$state_root/ssh-host-ed25519.pub"
ssh_host_fingerprint_file="$state_root/ssh-host-fingerprint"
ssh_proxy="$state_root/dim-ssh-proxy"
ssh_alias="$workspace_name-agent"
ssh_host_fingerprint=""

prepare_self_ssh_fixture() {
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
}

prepare_self_ssh_access() {
  dim workspace run "$workspace_name" bash -- -lc \
    'umask 077; mkdir -p "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; chmod 0700 "$HOME/.ssh"; chmod 0600 "$HOME/.ssh/authorized_keys"; cat >>"$HOME/.ssh/authorized_keys"; chown -R dim-agent:dim-agent "$HOME/.ssh"' \
    <"$ssh_key.pub"
  record_self_ssh_host_key initial
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
    rotated)
      ssh_host_fingerprint="$(<"$ssh_host_fingerprint_file")"
      test "$local_fingerprint" != "$ssh_host_fingerprint"
      ;;
    *) echo "unknown self-Project SSH host-key expectation: $expected_change" >&2; return 2 ;;
  esac
  ssh_host_fingerprint="$local_fingerprint"
  printf '%s\n' "$ssh_host_fingerprint" >"$ssh_host_fingerprint_file"
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
