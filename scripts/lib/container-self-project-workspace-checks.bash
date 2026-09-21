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
      printf "%s\n" "$security_options" | grep -q rootless
      test "${workspace_owner%%:*}" = "$(id -u rootless)"
      test "$(stat -c %u:%g:%a /usr/bin/newuidmap)" = 0:0:4755
      test "$(stat -c %u:%g:%a /usr/bin/newgidmap)" = 0:0:4755
    '
}

assert_opencode_absent() {
  dim workspace run "$workspace_name" bash -- -lc '! command -v opencode >/dev/null 2>&1'
}

verification_stage="initial agent-dind contract"
verify_agent_dind
assert_opencode_absent
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
  grep -Fqx 'qemu-control-probe-ok' <<<"$qemu_probe_output"
  if [[ "${DIM_SELF_STOP_AFTER_QEMU_PROBE:-0}" == 1 ]]; then
    echo "agent-qemu-control-smoke-ok"
    exit 0
  fi
fi

verification_stage="workspace restart"
dim workspace run "$workspace_name" bash -- -lc '
  printf "preserve metadata\n" > /home/dim-agent/.dim-home-metadata-sentinel
  chown dim-agent:dim-agent /home/dim-agent/.dim-home-metadata-sentinel
  chmod 0640 /home/dim-agent/.dim-home-metadata-sentinel
'
home_metadata_before="$(dim workspace run "$workspace_name" bash -- -lc \
  'stat -c %u:%g:%a /home/dim-agent/.dim-home-metadata-sentinel')"
if ! restart_error="$(dim workspace restart "$workspace_name" 2>&1)"; then
  printf '%s\n' "$restart_error" >&2
  dim workspace show "$workspace_name" >&2 || true
  dim workspace exec "$workspace_name" -- git -C /workspace/project status --short >&2 || true
  dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-project" --file .dim/docker-compose.yml ps >&2 || true
  exit 1
fi
workspace_json="$(dim workspace show "$workspace_name" --json)"
test "$(jq -r .phase <<<"$workspace_json")" = ready
verification_stage="restarted agent-dind contract"
verify_agent_dind
test "$(dim workspace run "$workspace_name" bash -- -lc \
  'stat -c %u:%g:%a /home/dim-agent/.dim-home-metadata-sentinel')" = "$home_metadata_before"
assert_opencode_absent

verification_stage="explicit workspace setup without user tooling"
dim workspace setup "$workspace_name" >/dev/null
assert_opencode_absent
verification_stage="workspace stop and start without user tooling"
dim workspace stop "$workspace_name" >/dev/null
dim workspace start "$workspace_name" >/dev/null
assert_opencode_absent
verification_stage="workspace update without user tooling"
dim workspace update "$workspace_name" >/dev/null
assert_opencode_absent

verification_stage="workspace resource update"
workspace_json="$(dim workspace show "$workspace_name" --json)"
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
container_name="$(jq -r .containerName <<<"$workspace_json")"
test "$(docker inspect "$container_name" --format \
  '{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.PidsLimit}}')" = \
  "1250000000|2147483648|2147483648|1024"
dim workspace resources "$workspace_name" \
  --cpus "$original_cpus" --memory "$original_memory" --pids "$original_pids" >/dev/null
assert_opencode_absent

verification_stage="workspace reviewed-file contract"
dim workspace exec "$workspace_name" -- \
  sh -c 'test -r .dim/setup.sh && test ! -x .dim/setup.sh && test -r .dim/entrypoint.sh && test ! -x .dim/entrypoint.sh && test -r .dim/docker-compose.yml && test "$DIM_GIT_BASE_URL" = "$(jq -r .gitBaseUrl "$DIM_PROJECT_MANIFEST")" && test -n "$(jq -r ".hostAliases[\"dim-gitea\"][0]" "$DIM_PROJECT_MANIFEST")"'
test "$(dim workspace show "$workspace_name" --json | jq -r .rootRef)" = "refs/heads/main"
agent_git_identity="$(dim workspace run "$workspace_name" bash -- -lc \
  'printf "%s <%s>|%s <%s>" "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL" "$GIT_COMMITTER_NAME" "$GIT_COMMITTER_EMAIL"')"
test "$agent_git_identity" = \
  "DIM Self Host <dim-self-host@dim.invalid>|DIM Self Host <dim-self-host@dim.invalid>"
verification_stage="agent identity"
workspace_owner_uid="$(dim workspace exec "$workspace_name" -- stat -c %u /workspace)"
test "$(dim workspace run "$workspace_name" bash -- -lc 'id -u')" = 0
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
