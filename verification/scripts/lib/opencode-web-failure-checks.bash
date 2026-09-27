assert_bounded_launcher_failure() {
  local limit="$1" diagnostic="$2" status=0
  shift 2
  timeout --kill-after=2s "$limit" env "${base_env[@]}" "$@" bash "$launcher" \
    >"$work_dir/bounded.stdout" 2>"$work_dir/bounded.stderr" || status=$?
  if [[ "$status" != 1 ]]; then
    printf 'expected bounded launcher failure, received status %s\n' "$status" >&2
    cat "$work_dir/bounded.stderr" >&2
    exit 1
  fi
  grep -Fq "$diagnostic" "$work_dir/bounded.stderr"
}

exec {held_lock_fd}>"$state_dir/launch.lock"
flock --exclusive "$held_lock_fd"
assert_bounded_launcher_failure 8s 'timed out waiting for the launch lock'
flock --unlock "$held_lock_fd"
exec {held_lock_fd}>&-
[[ ! -e "$state_dir/server.pid" ]]

readiness_port="$(available_port)"
assert_bounded_launcher_failure 20s 'did not own its listening socket before the readiness deadline' \
  OPENCODE_WEB_PORT="$readiness_port" MOCK_OPENCODE_STALL=1
[[ ! -e "$state_dir/server.pid" ]]
! curl --silent --max-time 1 "http://127.0.0.1:$readiness_port/global/health" >/dev/null

printf '%s\n' stall >"$mode_file"
helper_port="$(available_port)"
assert_bounded_launcher_failure 35s 'could not expose OpenCode Web' OPENCODE_WEB_PORT="$helper_port"
[[ ! -e "$state_dir/server.pid" ]]
! curl --silent --max-time 1 "http://127.0.0.1:$helper_port/global/health" >/dev/null
printf '%s\n' valid >"$mode_file"
: >"$arguments_file"
