declare -ag VERIFICATION_STAGE_NAMES=()
declare -Ag VERIFICATION_STAGE_FUNCTIONS=()
declare -Ag VERIFICATION_STAGE_DEPENDENCIES=()
declare -Ag VERIFICATION_STAGE_STATUSES=()
VERIFICATION_STAGE_ACTIVE_PID=""
VERIFICATION_STAGE_CURRENT_NAME=""
VERIFICATION_STAGE_CANCEL_STATUS=0
VERIFICATION_STAGE_CANCEL_NAME=""
VERIFICATION_STAGE_CANCEL_SIGNAL=""

verification_stage_register() {
  local name="$1"
  VERIFICATION_STAGE_NAMES+=("$name")
  VERIFICATION_STAGE_FUNCTIONS["$name"]="$2"
  VERIFICATION_STAGE_DEPENDENCIES["$name"]="$3"
}

verification_stage_blocking_dependency() {
  local dependency status
  for dependency in ${VERIFICATION_STAGE_DEPENDENCIES[$1]}; do
    status="${VERIFICATION_STAGE_STATUSES[$dependency]:-MISSING}"
    if [[ "$status" != PASS ]]; then
      printf '%s\t%s' "$dependency" "$status"
      return 0
    fi
  done
  return 1
}

verification_stage_run_internal() {
  local name="$1" function_name
  function_name="${VERIFICATION_STAGE_FUNCTIONS[$name]:-}"
  if [[ -z "$function_name" ]]; then
    printf 'unknown internal verification stage: %s\n' "$name" >&2
    return 2
  fi
  "$function_name"
}

verification_stage_stop_active_group() {
  local signal="$1" pid attempt
  [[ -n "$VERIFICATION_STAGE_ACTIVE_PID" ]] || return 0
  pid="$VERIFICATION_STAGE_ACTIVE_PID"
  kill -s "$signal" "$pid" 2>/dev/null || true
  kill -s "$signal" -- "-$pid" 2>/dev/null || true
  for attempt in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null && ! kill -0 -- "-$pid" 2>/dev/null; then
      break
    fi
    sleep 0.05
  done
  kill -KILL "$pid" 2>/dev/null || true
  kill -KILL -- "-$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  if [[ "$VERIFICATION_STAGE_ACTIVE_PID" == "$pid" ]]; then
    VERIFICATION_STAGE_ACTIVE_PID=""
  fi
}

verification_stage_handle_signal() {
  local signal="$1" status="$2"
  trap '' INT TERM HUP
  VERIFICATION_STAGE_CANCEL_SIGNAL="$signal"
  VERIFICATION_STAGE_CANCEL_STATUS="$status"
  VERIFICATION_STAGE_CANCEL_NAME="${VERIFICATION_STAGE_CURRENT_NAME:-runner}"
  verification_stage_stop_active_group "$signal"
}

verification_stage_run_one() {
  local name="$1" log_file="$DIM_VERIFICATION_LOG_ROOT/$1.log"
  local entrypoint launched_pid status evidence_status=0 errexit_enabled=0
  entrypoint="${DIM_VERIFICATION_STAGE_ENTRYPOINT:?DIM_VERIFICATION_STAGE_ENTRYPOINT must identify the registration script}"
  [[ "$entrypoint" == /* && -f "$entrypoint" ]] || {
    printf 'DIM_VERIFICATION_STAGE_ENTRYPOINT must be an absolute regular file\n' >&2
    return 2
  }
  [[ $- == *e* ]] && errexit_enabled=1
  set +e
  setsid /usr/bin/env DIM_VERIFICATION_INTERNAL_STAGE="$name" \
    /usr/bin/bash "$entrypoint" >"$log_file" 2>&1 &
  VERIFICATION_STAGE_ACTIVE_PID=$!
  launched_pid="$VERIFICATION_STAGE_ACTIVE_PID"
  if ((VERIFICATION_STAGE_CANCEL_STATUS != 0)); then
    verification_stage_stop_active_group "$VERIFICATION_STAGE_CANCEL_SIGNAL"
  fi
  wait "$launched_pid"
  status=$?
  if ((VERIFICATION_STAGE_CANCEL_STATUS != 0)); then
    status="$VERIFICATION_STAGE_CANCEL_STATUS"
  fi
  VERIFICATION_STAGE_ACTIVE_PID=""
  if ((errexit_enabled != 0)); then set -e; fi
  chmod 0600 "$log_file" || evidence_status=1
  cat "$log_file" || evidence_status=1
  if ((status == 0 && evidence_status != 0)); then status=1; fi
  VERIFICATION_STAGE_RESULT="$status"
}

verification_stage_run() {
  local name blocked dependency dependency_status fatal_reason="" fatal_stage=""
  local passed=0 failed=0 blocked_count=0
  : "${DIM_VERIFICATION_LOG_ROOT:?DIM_VERIFICATION_LOG_ROOT must identify the evidence directory}"
  umask 077
  mkdir -p "$DIM_VERIFICATION_LOG_ROOT"
  chmod 0700 "$DIM_VERIFICATION_LOG_ROOT"
  trap 'verification_stage_handle_signal HUP 129' HUP
  trap 'verification_stage_handle_signal INT 130' INT
  trap 'verification_stage_handle_signal TERM 143' TERM
  for name in "${VERIFICATION_STAGE_NAMES[@]}"; do
    if ((VERIFICATION_STAGE_CANCEL_STATUS != 0)) && [[ -z "$fatal_reason" ]]; then
      fatal_reason=cancelled
      fatal_stage="$VERIFICATION_STAGE_CANCEL_NAME"
    fi
    if [[ -n "$fatal_reason" ]]; then
      VERIFICATION_STAGE_STATUSES["$name"]=BLOCKED
      ((blocked_count += 1))
      printf 'BLOCKED %s reason=%s stage=%s\n' "$name" "$fatal_reason" "$fatal_stage"
      continue
    fi
    if blocked="$(verification_stage_blocking_dependency "$name")"; then
      IFS=$'\t' read -r dependency dependency_status <<<"$blocked"
      VERIFICATION_STAGE_STATUSES["$name"]=BLOCKED
      ((blocked_count += 1))
      printf 'BLOCKED %s dependency=%s dependency_status=%s\n' \
        "$name" "$dependency" "$dependency_status"
      continue
    fi
    VERIFICATION_STAGE_CURRENT_NAME="$name"
    verification_stage_run_one "$name"
    if ((VERIFICATION_STAGE_RESULT == 0)); then
      VERIFICATION_STAGE_STATUSES["$name"]=PASS
      ((passed += 1))
      printf 'PASS %s status=0 log=%s/%s.log\n' \
        "$name" "$DIM_VERIFICATION_LOG_ROOT" "$name"
    else
      VERIFICATION_STAGE_STATUSES["$name"]=FAIL
      ((failed += 1))
      printf 'FAIL %s status=%d log=%s/%s.log\n' \
        "$name" "$VERIFICATION_STAGE_RESULT" "$DIM_VERIFICATION_LOG_ROOT" "$name"
      if ((VERIFICATION_STAGE_RESULT == 125)); then
        fatal_reason=unsafe-cleanup
        fatal_stage="$name"
      elif ((VERIFICATION_STAGE_CANCEL_STATUS != 0)); then
        fatal_reason=cancelled
        fatal_stage="$name"
      fi
    fi
  done
  trap - INT TERM HUP
  printf 'verification-stage-summary passed=%d failed=%d blocked=%d logs=%s\n' \
    "$passed" "$failed" "$blocked_count" "$DIM_VERIFICATION_LOG_ROOT"
  if ((VERIFICATION_STAGE_CANCEL_STATUS != 0)); then
    return "$VERIFICATION_STAGE_CANCEL_STATUS"
  fi
  if [[ "$fatal_reason" == unsafe-cleanup ]]; then
    return 125
  fi
  ((failed == 0 && blocked_count == 0))
}
