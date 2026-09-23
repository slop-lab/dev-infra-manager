#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
work_dir="$(mktemp -d /tmp/dim-project-tool-tasks.XXXXXX)"
trap 'rm -rf -- "$work_dir"' EXIT

entrypoint="$repo_root/project/.dim/entrypoint.sh"
fixture_bin="$work_dir/bin"
mkdir -p "$fixture_bin"

cat >"$work_dir/local-setup.bash" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
: >"$DIM_TOOL_FIXTURE_STATE"
printf '%s\n' setup-ok
EOF

cat >"$fixture_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$DIM_TOOL_FIXTURE_LOG"
while (($#)); do
  if [[ "$1" == dim-agent-dind && "${2:-}" == exec ]]; then
    shift 2
    break
  fi
  shift
done
case "${1:-} ${2:-}" in
  "bash /workspace/scripts/workspace-user-setup.bash")
    exec bash "$DIM_TOOL_FIXTURE_LOCAL_SETUP"
    ;;
  "bash -s")
    exec bash -s
    ;;
  "$DIM_PROJECT_TOOL_RUNNER 1")
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
export DIM_TOOL_FIXTURE_LOCAL_SETUP="$work_dir/local-setup.bash"
export DIM_PROJECT_TOOL_RUNNER=/home/dim-agent/.local/libexec/dim-project-tool-launch
export PATH="$fixture_bin:$PATH"

stdin_marker="$work_dir/stdin-marker"
setup_output="$(printf ': >%q\n' "$stdin_marker" | sh "$entrypoint" tool-setup)"
[[ "$setup_output" = setup-ok ]]
[[ ! -e "$stdin_marker" ]]
printf 'printf remote-ok >%q\n' "$stdin_marker" | sh "$entrypoint" bash -s
[[ "$(cat "$stdin_marker")" = remote-ok ]]
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
