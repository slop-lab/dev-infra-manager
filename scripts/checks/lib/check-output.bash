# Source-check presentation only; commands keep their own exit and cleanup rules.
check_output_read_uptime() {
  local uptime unused
  if { read -r uptime unused </proc/uptime; } 2>/dev/null && [[ "$uptime" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    printf '%s' "${uptime%%.*}"
  else
    return 1
  fi
}

check_output_read_node_clock() {
  [[ -n "${CHECK_OUTPUT_NODE:-}" ]] || return 1
  "$CHECK_OUTPUT_NODE" -e 'process.stdout.write((process.hrtime.bigint() / 1000000000n).toString())' 2>/dev/null
}

check_output_monotonic_seconds() {
  local value=""
  case "$CHECK_OUTPUT_CLOCK" in
    proc) value="$(check_output_read_uptime)" || value="" ;;
    node) value="$(check_output_read_node_clock)" || value="" ;;
  esac
  if [[ "$value" =~ ^[0-9]+$ ]]; then printf '%s' "$value"; else printf 'null'; fi
}

check_output_elapsed_seconds() {
  if [[ "$1" =~ ^[0-9]+$ && "$2" =~ ^[0-9]+$ ]] && (( $1 >= $2 )); then
    printf '%s' "$(( $1 - $2 ))"
  else
    printf 'null'
  fi
}

check_output_init() {
  local parent="$1"
  CHECK_OUTPUT_ROOT="$(umask 077; mkdir -p -- "$parent"; mktemp -d "$parent/run.XXXXXX")"
  CHECK_OUTPUT_SEQUENCE=0
  CHECK_OUTPUT_HEARTBEAT=""
  # BOOTTIME and MONOTONIC have different origins after suspend. Select once;
  # a later read failure loses timing only, never the command or its exit code.
  CHECK_OUTPUT_CLOCK=none
  CHECK_OUTPUT_NODE="$(command -v node 2>/dev/null)" || CHECK_OUTPUT_NODE=""
  if check_output_read_uptime >/dev/null; then CHECK_OUTPUT_CLOCK=proc
  elif check_output_read_node_clock >/dev/null; then CHECK_OUTPUT_CLOCK=node
  fi
  (umask 077; : >"$CHECK_OUTPUT_ROOT/stages.jsonl")
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
  local name="$1" log status started ended utc
  shift
  [[ "$name" =~ ^[a-z0-9-]+$ ]] || return 2
  started="$(check_output_monotonic_seconds)"
  utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  CHECK_OUTPUT_SEQUENCE=$((CHECK_OUTPUT_SEQUENCE + 1))
  printf -v log '%s/%02d-%s.log' "$CHECK_OUTPUT_ROOT" "$CHECK_OUTPUT_SEQUENCE" "$name"
  (umask 077; : >"$log")
  printf '[check] %s started=%s\n' "$name" "$utc"
  printf '{"stage":"%s","event":"start","utc":"%s","monotonicSeconds":%s}\n' "$name" "$utc" "$started" >>"$CHECK_OUTPUT_ROOT/stages.jsonl"
  (
    timer=""
    trap 'if [[ -n "$timer" ]]; then kill "$timer" 2>/dev/null || true; wait "$timer" 2>/dev/null || true; fi; exit 0' TERM INT HUP
    while true; do
      sleep 30 &
      timer=$!
      wait "$timer" || exit 0
      timer=""
      elapsed="$(check_output_elapsed_seconds "$(check_output_monotonic_seconds)" "$started")"
      if [[ "$elapsed" == null ]]; then elapsed='elapsed unavailable'; else elapsed="${elapsed}s"; fi
      printf '[check] %s running (%s) utc=%s\n' "$name" "$elapsed" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
    done
  ) &
  CHECK_OUTPUT_HEARTBEAT=$!
  if (
    if [[ "${DIM_CHECK_VERBOSE:-0}" != 1 ]]; then unset FORCE_COLOR; export NO_COLOR=1; fi
    "$@"
  ) >"$log" 2>&1; then status=0; else status=$?; fi
  check_output_stop
  ended="$(check_output_monotonic_seconds)"
  utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"stage":"%s","event":"finish","utc":"%s","monotonicSeconds":%s,"elapsedSeconds":%s,"exitCode":%s}\n' "$name" "$utc" "$ended" "$(check_output_elapsed_seconds "$ended" "$started")" "$status" >>"$CHECK_OUTPUT_ROOT/stages.jsonl"
  if (( status != 0 )); then
    printf '[check] FAIL %s exit=%s log=%s (last 160 lines)\n' "$name" "$status" "$log" >&2
    tail -n 160 -- "$log" >&2
  elif [[ "${DIM_CHECK_VERBOSE:-0}" == 1 ]]; then
    cat -- "$log"
  fi
  return "$status"
}
