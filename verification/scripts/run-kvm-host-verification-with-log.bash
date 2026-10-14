#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node_executable=/usr/local/lib/dim-qemu-node-24.19.0/bin/node
log_directory="${DIM_HOST_VERIFICATION_LOG_DIR:-$repository_root/.local/verification-logs}"
run_id="$(date -u +%Y%m%dT%H%M%SZ)"
log_path="$log_directory/kvm-host-$run_id.log"

if [[ "$(id -u)" == 0 ]]; then
  echo "run this script as the normal host operator, not as root" >&2
  exit 2
fi
if [[ $# -ne 0 ]]; then
  echo "usage: bash verification/scripts/run-kvm-host-verification-with-log.bash" >&2
  exit 2
fi

mkdir -p -- "$log_directory"
chmod 0700 -- "$log_directory"
touch -- "$log_path"
chmod 0600 -- "$log_path"
exec > >(tee -a "$log_path") 2>&1

finish() {
  status=$?
  trap - EXIT
  printf '\nKVM host verification exit status: %s\n' "$status"
  printf 'Persistent log: %s\n' "$log_path"
  exit "$status"
}
trap finish EXIT

printf 'KVM host verification started: %s\n' "$run_id"
printf 'Repository: %s\n' "$repository_root"
printf 'Revision: %s\n' "$(git -C "$repository_root" rev-parse HEAD)"
printf 'Log: %s\n\n' "$log_path"
printf 'sudo may request a password on this terminal; password input is not written to the log.\n'
sudo -v

printf '\n== Run preflight and the full KVM gate with refreshed kvm membership ==\n'
printf -v operator_command \
  'cd %q && export DIM_QEMU_NODE_EXECUTABLE=%q && sudo -v && bash verification/scripts/kvm-host-install-smoke.bash --preflight-only && just verify environments-kvm' \
  "$repository_root" "$node_executable"
sg kvm -c "$operator_command"

printf '\nKVM host verification passed.\n'
