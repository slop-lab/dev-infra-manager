# Source-check presentation only; commands keep their own exit and cleanup rules.
check_output_init() {
  local parent="$1"
  CHECK_OUTPUT_ROOT="$(umask 077; mkdir -p -- "$parent"; mktemp -d "$parent/run.XXXXXX")"
  CHECK_OUTPUT_SEQUENCE=0
  CHECK_OUTPUT_HEARTBEAT=""
  printf '[check] logs: %s\n' "$CHECK_OUTPUT_ROOT"
}

check_output_stop() {
  if [[ -n "${CHECK_OUTPUT_HEARTBEAT:-}" ]]; then
    kill "$CHECK_OUTPUT_HEARTBEAT" 2>/dev/null || true
    wait "$CHECK_OUTPUT_HEARTBEAT" 2>/dev/null || true
    CHECK_OUTPUT_HEARTBEAT=""
  fi
}

check_output_run() {
  local name="$1" log status started=$SECONDS
  shift
  [[ "$name" =~ ^[a-z0-9-]+$ ]] || return 2
  CHECK_OUTPUT_SEQUENCE=$((CHECK_OUTPUT_SEQUENCE + 1))
  printf -v log '%s/%02d-%s.log' "$CHECK_OUTPUT_ROOT" "$CHECK_OUTPUT_SEQUENCE" "$name"
  (umask 077; : >"$log")
  printf '[check] %s\n' "$name"
  (
    timer=""
    trap 'if [[ -n "$timer" ]]; then kill "$timer" 2>/dev/null || true; wait "$timer" 2>/dev/null || true; fi; exit 0' TERM INT HUP
    while true; do
      sleep 30 &
      timer=$!
      wait "$timer" || exit 0
      timer=""
      printf '[check] %s running (%ss)\n' "$name" "$((SECONDS - started))" >&2
    done
  ) &
  CHECK_OUTPUT_HEARTBEAT=$!
  if (
    if [[ "${DIM_CHECK_VERBOSE:-0}" != 1 ]]; then unset FORCE_COLOR; export NO_COLOR=1; fi
    "$@"
  ) >"$log" 2>&1; then status=0; else status=$?; fi
  check_output_stop
  if (( status != 0 )); then
    printf '[check] FAIL %s exit=%s log=%s (last 160 lines)\n' "$name" "$status" "$log" >&2
    tail -n 160 -- "$log" >&2
  elif [[ "${DIM_CHECK_VERBOSE:-0}" == 1 ]]; then
    cat -- "$log"
  fi
  return "$status"
}
