declare -ag SELF_PHASE_NAMES=()
declare -Ag SELF_PHASE_FUNCTIONS=()
declare -Ag SELF_PHASE_DEPENDENCIES=()
declare -Ag SELF_PHASE_DESCRIPTIONS=()
declare -Ag SELF_PHASE_SELECTED=()
declare -Ag SELF_PHASE_STATUSES=()

self_phase_register() {
  local name="$1"
  SELF_PHASE_NAMES+=("$name")
  SELF_PHASE_FUNCTIONS["$name"]="$2"
  SELF_PHASE_DEPENDENCIES["$name"]="$3"
  SELF_PHASE_DESCRIPTIONS["$name"]="$4"
}

self_phase_usage() {
  cat <<'EOF'
Usage: container-self-project-smoke.bash [--phase NAME]...

Run the complete self-Project gate by default. Repeat --phase to run only
named independent checks. DIM_SELF_PHASES accepts the same names separated by
commas. Setup always runs; selected checks share its prepared workspace.

Options:
  --phase NAME    Run one named phase; may be repeated
  --list-phases   List stable phase names and descriptions
  --help          Show this help
EOF
}

self_phase_list() {
  local name
  for name in "${SELF_PHASE_NAMES[@]}"; do
    printf '%s\t%s\n' "$name" "${SELF_PHASE_DESCRIPTIONS[$name]}"
  done
}

self_phase_select() {
  local name="$1"
  if [[ -z "${SELF_PHASE_FUNCTIONS[$name]:-}" ]]; then
    printf 'unknown self-Project phase: %s\n' "$name" >&2
    return 2
  fi
  SELF_PHASE_SELECTED["$name"]=1
}

self_phase_parse() {
  local phase
  local selection="${DIM_SELF_PHASES:-}"
  if [[ -n "$selection" ]]; then
    while IFS= read -r phase; do
      [[ -n "$phase" ]] || continue
      self_phase_select "$phase" || return
    done < <(tr ',' '\n' <<<"$selection")
  fi
  while (($#)); do
    case "$1" in
      --phase)
        if (($# < 2)); then
          echo "--phase requires a name" >&2
          return 2
        fi
        self_phase_select "$2" || return
        shift 2
        ;;
      --list-phases)
        self_phase_list
        exit 0
        ;;
      --help|-h)
        self_phase_usage
        exit 0
        ;;
      *)
        printf 'unknown self-Project option: %s\n' "$1" >&2
        return 2
        ;;
    esac
  done
  if ((${#SELF_PHASE_SELECTED[@]} == 0)); then
    for phase in "${SELF_PHASE_NAMES[@]}"; do
      SELF_PHASE_SELECTED["$phase"]=1
    done
  fi
}

self_phase_failed_dependency() {
  local dependency
  for dependency in ${SELF_PHASE_DEPENDENCIES[$1]}; do
    [[ -n "${SELF_PHASE_SELECTED[$dependency]:-}" ]] || continue
    if [[ "${SELF_PHASE_STATUSES[$dependency]:-pending}" != pass ]]; then
      printf '%s' "$dependency"
      return 0
    fi
  done
  return 1
}

self_phase_run_one() {
  local name="$1"
  local log_file="$DIM_PHASE_LOG_ROOT/$name.log"
  local started_at status errexit_enabled=0
  started_at="$(date +%s)"
  [[ $- == *e* ]] && errexit_enabled=1
  set +e
  (
    set -euo pipefail
    "${SELF_PHASE_FUNCTIONS[$name]}"
  ) >"$log_file" 2>&1
  status=$?
  ((errexit_enabled == 0)) || set -e
  chmod 0600 "$log_file"
  cat "$log_file"
  SELF_PHASE_DURATION="$(( $(date +%s) - started_at ))s"
  SELF_PHASE_RESULT="$status"
}

self_phase_run() {
  local name dependency
  local passed=0 failed=0 skipped=0
  local run_started_at
  run_started_at="$(date +%s)"
  : "${DIM_PHASE_LOG_ROOT:?DIM_PHASE_LOG_ROOT must identify the durable evidence directory}"
  umask 077
  mkdir -p "$DIM_PHASE_LOG_ROOT"
  chmod 0700 "$DIM_PHASE_LOG_ROOT"
  for name in "${SELF_PHASE_NAMES[@]}"; do
    [[ -n "${SELF_PHASE_SELECTED[$name]:-}" ]] || continue
    if dependency="$(self_phase_failed_dependency "$name")"; then
      SELF_PHASE_STATUSES["$name"]=skip
      ((skipped += 1))
      printf 'SKIP %s dependency=%s\n' "$name" "$dependency"
      continue
    fi
    self_phase_run_one "$name"
    if ((SELF_PHASE_RESULT == 0)); then
      SELF_PHASE_STATUSES["$name"]=pass
      ((passed += 1))
      printf 'PASS %s duration=%s log=%s/%s.log\n' "$name" "$SELF_PHASE_DURATION" "$DIM_PHASE_LOG_ROOT" "$name"
    else
      SELF_PHASE_STATUSES["$name"]=fail
      ((failed += 1))
      printf 'FAIL %s duration=%s log=%s/%s.log\n' "$name" "$SELF_PHASE_DURATION" "$DIM_PHASE_LOG_ROOT" "$name"
    fi
  done
  printf 'self-project-phase-summary passed=%d failed=%d skipped=%d duration=%ds logs=%s\n' \
    "$passed" "$failed" "$skipped" "$(( $(date +%s) - run_started_at ))" "$DIM_PHASE_LOG_ROOT"
  ((failed == 0 && skipped == 0))
}
