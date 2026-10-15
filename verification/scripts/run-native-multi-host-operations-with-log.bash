#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
log_directory="${DIM_NATIVE_MULTI_HOST_LOG_DIR:-$repository_root/.local/verification-logs}"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
log_path="$log_directory/native-multi-host-operations-$run_id.log"

if [[ $# -ne 1 || "$1" != /* ]]; then
  echo "usage: bash verification/scripts/run-native-multi-host-operations-with-log.bash /absolute/operator.conf" >&2
  exit 2
fi
config_path="$1"

mkdir -p -- "$log_directory"
chmod 0700 -- "$log_directory"
touch -- "$log_path"
chmod 0600 -- "$log_path"
exec > >(tee -a "$log_path") 2>&1

evidence_directory=""
finish() {
  status=$?
  trap - EXIT
  printf '\nNative multi-host operations exit status: %s\n' "$status"
  printf 'Persistent log: %s\n' "$log_path"
  if [[ -n "$evidence_directory" && -f "$evidence_directory/OPS-PASSED" ]]; then
    printf 'OPS-PASSED: %s\n' "$evidence_directory/OPS-PASSED"
    printf 'OPS-PASSED SHA-256: '
    sha256sum -- "$evidence_directory/OPS-PASSED" | awk '{ print $1 }'
  elif [[ -n "$evidence_directory" ]]; then
    printf 'OPS-PASSED was not published under: %s\n' "$evidence_directory"
  fi
  exit "$status"
}
trap finish EXIT

printf 'Native multi-host operations started: %s\n' "$run_id"
printf 'Repository: %s\n' "$repository_root"
printf 'Revision: %s\n' "$(git -C "$repository_root" rev-parse HEAD)"
printf 'Operator config: %s (contents intentionally not logged)\n' "$config_path"
printf 'Log: %s\n' "$log_path"

printf '\n== Fixed command plan ==\n'
bash "$repository_root/verification/scripts/native-multi-host-operations.bash" --print-command-plan

printf '\n== Read-only preflight ==\n'
just --justfile "$repository_root/justfile" --working-directory "$repository_root" \
  verify native-multi-host-operations-preflight "$config_path"

# Read only the non-secret evidence destination after the gate has validated the
# complete config. Do not source the operator file or print any other value.
evidence_directory="$(awk -F= '$1 == "EVIDENCE_DIR" { print substr($0, index($0, "=") + 1) }' "$config_path")"

printf '\n== Full two-node operations gate ==\n'
just --justfile "$repository_root/justfile" --working-directory "$repository_root" \
  verify native-multi-host-operations "$config_path"

[[ -f "$evidence_directory/OPS-PASSED" ]] || {
  echo "operations command returned success without OPS-PASSED" >&2
  exit 1
}
printf '\nNative multi-host operations passed.\n'
