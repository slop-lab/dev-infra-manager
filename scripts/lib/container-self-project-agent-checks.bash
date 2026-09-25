verification_stage="protected and unprotected repository pushes"
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
verification_stage="provider-neutral agent command"
test "$(dim workspace run "$workspace_name" bash -- -lc 'printf provider-neutral-bash-ok')" = \
  provider-neutral-bash-ok
verification_stage="removed agent task contract"
for removed_task in codex claude check; do
  removed_task_error="$state_root/$removed_task-task.stderr"
  if dim workspace run "$workspace_name" "$removed_task" \
    >"$state_root/$removed_task-task.stdout" 2>"$removed_task_error"; then
    echo "removed $removed_task task unexpectedly succeeded" >&2
    exit 1
  fi
  test "$(tr -d '\r' <"$removed_task_error")" = "unknown DIM project task: $removed_task"
done

verification_stage="explicit workspace-user setup"
(
  cd "$integrated_source/scripts"
  sha256sum --check workspace-user-setup.bash.sha256
)
dim workspace run "$workspace_name" bash -- -lc \
  'command -v flock >/dev/null || { echo "flock is required for workspace user setup" >&2; exit 1; }'
dim workspace run "$workspace_name" tool-setup >/dev/null

workspace_user_setup_state() {
  dim workspace run "$workspace_name" agent -- --version | grep -qx 1.18.31
  dim workspace run "$workspace_name" bash -- -lc \
    'node /workspace/verification/scripts/lib/workspace-user-setup-assertions.cjs "$HOME/.local" "$HOME/.config/opencode/opencode.json" "$HOME/.omo/omo.jsonc" fresh'
  dim workspace run "$workspace_name" bash -- -lc \
    'sha256sum "$HOME/.config/opencode/opencode.json" "$HOME/.omo/omo.jsonc"'
}

inner_agent_id() {
  local outer_agent_dind
  outer_agent_dind="$(dim workspace exec "$workspace_name" -- \
    docker compose --project-name "dim-project" --file .dim/docker-compose.yml ps --quiet agent-dind)"
  dim workspace exec "$workspace_name" -- \
    docker exec "$outer_agent_dind" dim-agent-dind inspect --format '{{.Id}}'
}

verification_stage="workspace-user setup validation task"
setup_state_before="$(workspace_user_setup_state)"
inner_agent_before="$(inner_agent_id)"
verification_stage="inner agent recreation with persistent user tooling"
dim workspace setup "$workspace_name" >/dev/null
inner_agent_after="$(inner_agent_id)"
test "$inner_agent_after" != "$inner_agent_before"
verify_agent_dind
test "$(dim workspace run "$workspace_name" bash -- -lc \
  'stat -c %u:%g:%a /home/dim-agent/.dim-home-metadata-sentinel')" = "$home_metadata_before"
setup_state_after="$(workspace_user_setup_state)"
test "$setup_state_after" = "$setup_state_before"

dim workspace run "$workspace_name" bash -- -c \
  'mkdir -p /tmp/dim-self-project-root/.dim; cat > /tmp/dim-self-project-root/.dim/reconcile-repositories.sh' \
  <"$project_source/.dim/reconcile-repositories.sh"
dim workspace run "$workspace_name" bash -- -lc \
  "DIM_ROOT_REPOSITORY=/tmp/dim-self-project-root bash verification/scripts/repository-materialization-smoke.bash" >/dev/null
if [[ "${DIM_SELF_VERIFY_AGENT:-0}" == 1 ]]; then
  verification_stage="full agent verification"
  dim workspace run "$workspace_name" bash -- -lc \
    "DIM_ROOT_REPOSITORY=/tmp/dim-self-project-root DIM_EXPECT_ARCHIVE_URL='$source_root/remotes/archive.git' just verify agent" \
    >"$agent_verification_log" 2>&1
fi
dim workspace run "$workspace_name" bash -- -c 'rm -rf /tmp/dim-self-project-root'
