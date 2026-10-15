#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/lib/native-cutover-clean-host-common.bash"
source "$script_dir/lib/native-multi-host-operations-common.bash"
source "$script_dir/lib/native-multi-host-operations-evidence.bash"
source "$script_dir/lib/native-multi-host-operations-run.bash"
source "$script_dir/lib/native-multi-host-operations-cleanup.bash"

declare -A OPS_CONFIG=()
readonly OPS_REQUIRED_KEYS=(
  CONTROL_SSH ORDINARY_SSH EXPECTED_COMMIT CONTROL_SOURCE_ROOT ORDINARY_SOURCE_ROOT
  CONTROL_INSTALL_CONFIG PROJECT_NAME PROJECT_ID PROJECT_SOURCE PROJECT_REF PROJECT_COMMIT
  REGISTRAR_CONNECTION IMPORTER_CONNECTION CONTROL_PLANE_CONNECTION WORKSPACE_NAME WORKSPACE_REPOSITORY
  ORDINARY_HOST_CONFIG ORDINARY_HOST_ID ORDINARY_UNIT ORDINARY_STATE_DIRECTORY
  QEMU_SCHEDULER_CONFIG QEMU_HOST_CONFIG QEMU_HOST_ID QEMU_SCHEDULER_UNIT QEMU_HOST_UNIT
  NATIVE_GIT_CONTAINER ORDINARY_CI_CONTAINER ORDINARY_JOB QEMU_JOB ORDINARY_MARKER QEMU_MARKER
  EVIDENCE_DIR PROTECTED_QEMU_MODE DISPOSABLE_EXCLUSIVE_NODES_ACK
)
readonly OPS_ALL_KEYS=("${OPS_REQUIRED_KEYS[@]}")
readonly OPS_PATH_KEYS=(
  CONTROL_SOURCE_ROOT ORDINARY_SOURCE_ROOT CONTROL_INSTALL_CONFIG PROJECT_SOURCE
  REGISTRAR_CONNECTION IMPORTER_CONNECTION CONTROL_PLANE_CONNECTION WORKSPACE_REPOSITORY
  ORDINARY_HOST_CONFIG ORDINARY_STATE_DIRECTORY QEMU_SCHEDULER_CONFIG QEMU_HOST_CONFIG EVIDENCE_DIR
)
readonly OPS_IDENTIFIER_KEYS=(
  ORDINARY_HOST_ID QEMU_HOST_ID
)
readonly OPS_UNIT_KEYS=(ORDINARY_UNIT QEMU_SCHEDULER_UNIT QEMU_HOST_UNIT)
readonly OPS_CONTAINER_KEYS=(NATIVE_GIT_CONTAINER ORDINARY_CI_CONTAINER)
readonly OPS_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
OPS_WORKSPACE_CREATED=0
OPS_WORKSPACE_CREATION_ATTEMPTED=0
OPS_WORKSPACE_ID=''
OPS_QEMU_SCHEDULER_ARMED=0
OPS_QEMU_HOST_ARMED=0
OPS_ORDINARY_ARMED=0
OPS_CLEANUP_COMPLETE=0

ops_help() {
  cat <<EOF
usage: $(basename "$0") [--preflight-only] /absolute/operator.conf
       $(basename "$0") --print-command-plan
       $(basename "$0") --help

Runs pre-stable two-node control/QEMU plus ordinary operational verification.
The mode-0600 config must contain exactly the documented keys, including
DISPOSABLE_EXCLUSIVE_NODES_ACK=control-qemu-and-ordinary.

Options:
  --help                Show this help without reading config or contacting hosts.
  --print-command-plan  Print the fixed operation phases without contacting hosts.
  --preflight-only      Run bounded read-only checks plus owned temporary Docker probes.

Preflight does not install, start units, create Project/workspace state, or create evidence.
Its existing Sysbox/KVM checks temporarily create only ownership-labelled probe containers.
This runner never resolves, inspects, approves, or promotes a review and never writes the
protected ref. OPS-PASSED is operational evidence, not stable acceptance or a release gate.
EOF
}

ops_print_command_plan() {
  printf '%s\n' \
    'preflight:distinct-linux-machine-boot-docker-state-identities' \
    'preflight:exact-source-prepared-artifacts-private-configs-sysbox-kvm' \
    'preflight:inactive-exact-units-empty-claims-journals-new-project-workspace' \
    'install:same-prepared-candidate-control-and-ordinary' \
    'control-plane:install-bundle-create-project-workspace-before-ci' \
    'ci:start-scheduler-ready-before-qemu-and-ordinary-workers' \
    'proposal:proposal-only-two-unique-candidates-no-negative-push-probes' \
    'evidence:direct-envelope2-and-host-bound-dual-terminal-results' \
    'restart:clean-idle-workers-before-scheduler-invocation-ids-change' \
    'protected-ref:workspace-ls-remote-unchanged-after-both-runs' \
    'cleanup:armed-units-new-workspace-exact-owned-residue-only' \
    'result:credential-scan-atomic-OPS-PASSED-full-release-gate-not-satisfied'
}

ops_usage_error() {
  printf 'usage: %s [--preflight-only] /absolute/operator.conf\n' "$(basename "$0")" >&2
  exit 2
}

case "${1:-}" in
  --help) [[ "$#" -eq 1 ]] || ops_usage_error; ops_help; exit 0 ;;
  --print-command-plan) [[ "$#" -eq 1 ]] || ops_usage_error; ops_print_command_plan; exit 0 ;;
esac
preflight_only=0
if [[ "${1:-}" == --preflight-only ]]; then preflight_only=1; shift; fi
[[ "$#" -eq 1 ]] || ops_usage_error
ops_require_config "$1"

for command in ssh jq stat sha256sum grep chmod mv; do
  command -v "$command" >/dev/null || ops_die "install required operator command '$command'" 2
done
[[ ! -e "${OPS_CONFIG[EVIDENCE_DIR]}" && ! -L "${OPS_CONFIG[EVIDENCE_DIR]}" ]] ||
  ops_die 'EVIDENCE_DIR must not already exist' 2

ops_preflight
if [[ "$preflight_only" -eq 1 ]]; then
  printf '%s\n' 'native multi-host operations preflight available: bounded probes only; physical independence is operator-asserted'
  exit 0
fi

umask 077
mkdir -m 700 -- "${OPS_CONFIG[EVIDENCE_DIR]}"
OPS_EVIDENCE="${OPS_CONFIG[EVIDENCE_DIR]}"
ops_print_command_plan >"$OPS_EVIDENCE/command-plan.txt"
jq -cn --argjson control "$OPS_CONTROL_IDENTITY" --argjson ordinary "$OPS_ORDINARY_IDENTITY" \
  '{schemaVersion:1,controlQemu:$control,ordinary:$ordinary,
    administrativeIndependence:"operator-asserted-not-machine-proved"}' >"$OPS_EVIDENCE/nodes.json"
trap 'ops_cleanup_trap "$?"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
ops_execute
attempts="$(<"$OPS_EVIDENCE/attempts.json")"
ops_cleanup_exact
ops_publish_passed "$attempts"
trap - EXIT HUP INT TERM
printf 'native multi-host operations passed; evidence=%s retained=Project-and-control-plane\n' "$OPS_EVIDENCE"
