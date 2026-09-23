#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
work_dir="$(mktemp -d /tmp/dim-project-tool-tasks.XXXXXX)"
trap 'rm -rf -- "$work_dir"' EXIT

entrypoint="$repo_root/project/.dim/entrypoint.sh"
fixture_bin="$work_dir/bin"
mkdir -p "$fixture_bin"

cat >"$fixture_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$DIM_TOOL_FIXTURE_LOG"
case " $* " in
  *" bash /workspace/scripts/workspace-user-setup.bash "*)
    : >"$DIM_TOOL_FIXTURE_STATE"
    printf '%s\n' setup-ok
    ;;
  *"dim-project-tool-launch 1 agent opencode 1.18.31 /home/dim-agent/.local/bin/opencode "*)
    [[ -e "$DIM_TOOL_FIXTURE_STATE" ]]
    printf 'agent-ok'
    printf ' %s' "${@: -2}"
    printf '\n'
    ;;
  *)
    printf 'unexpected docker invocation: %s\n' "$*" >&2
    exit 97
    ;;
esac
EOF
chmod 0700 "$fixture_bin/docker"

export DIM_TOOL_FIXTURE_LOG="$work_dir/docker.log"
export DIM_TOOL_FIXTURE_STATE="$work_dir/compatible-tool-state"
export PATH="$fixture_bin:$PATH"

setup_output="$(sh "$entrypoint" tool-setup)"
[[ "$setup_output" = setup-ok ]]
if sh "$entrypoint" tool-setup unexpected >"$work_dir/setup-arguments.stdout" 2>"$work_dir/setup-arguments.stderr"; then
  printf 'tool-setup unexpectedly accepted arguments\n' >&2
  exit 1
fi
[[ "$(cat "$work_dir/setup-arguments.stderr")" = "tool-setup does not accept arguments" ]]
agent_output="$(sh "$entrypoint" agent --mode fixture)"
[[ "$agent_output" = "agent-ok --mode fixture" ]]

for task in unknown codex claude; do
  if sh "$entrypoint" "$task" >"$work_dir/$task.stdout" 2>"$work_dir/$task.stderr"; then
    printf 'unknown task unexpectedly succeeded: %s\n' "$task" >&2
    exit 1
  fi
  [[ "$(cat "$work_dir/$task.stderr")" = "unknown DIM project task: $task" ]]
done

printf '%s\n' project-tool-tasks-smoke-ok
