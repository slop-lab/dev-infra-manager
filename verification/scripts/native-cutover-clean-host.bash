#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/lib/native-cutover-clean-host-common.bash"
source "$script_dir/lib/native-cutover-clean-host-run.bash"
source "$script_dir/lib/native-cutover-clean-host-evidence.bash"

declare -A CUTOVER_CONFIG=()
readonly CUTOVER_REQUIRED_KEYS=(
  CONTROL_SSH ORDINARY_SSH EXPECTED_COMMIT CONTROL_SOURCE_ROOT ORDINARY_SOURCE_ROOT
  CONTROL_INSTALL_CONFIG PROJECT_NAME PROJECT_ID PROJECT_SOURCE PROJECT_REF PROJECT_COMMIT
  REGISTRAR_CONNECTION IMPORTER_CONNECTION CONTROL_PLANE_CONNECTION WORKSPACE_NAME WORKSPACE_REPOSITORY
  ORDINARY_ADMISSION_CONFIG ORDINARY_HOST_CONFIG ORDINARY_HOST_ID ORDINARY_UNIT ORDINARY_STATE_DIRECTORY
  QEMU_SCHEDULER_CONFIG QEMU_HOST_CONFIG QEMU_HOST_ID QEMU_SCHEDULER_UNIT QEMU_HOST_UNIT
  PROMOTER_CONNECTION REVIEWER_CONNECTION NATIVE_GIT_CONTAINER ORDINARY_CI_CONTAINER
  ORDINARY_JOB QEMU_JOB ORDINARY_MARKER QEMU_MARKER EVIDENCE_DIR PROTECTED_QEMU_MODE
)
readonly CUTOVER_ALL_KEYS=("${CUTOVER_REQUIRED_KEYS[@]}")
readonly CUTOVER_PATH_KEYS=(
  CONTROL_SOURCE_ROOT ORDINARY_SOURCE_ROOT CONTROL_INSTALL_CONFIG PROJECT_SOURCE REGISTRAR_CONNECTION
  IMPORTER_CONNECTION CONTROL_PLANE_CONNECTION WORKSPACE_REPOSITORY ORDINARY_ADMISSION_CONFIG
  ORDINARY_HOST_CONFIG ORDINARY_STATE_DIRECTORY QEMU_SCHEDULER_CONFIG QEMU_HOST_CONFIG
  PROMOTER_CONNECTION REVIEWER_CONNECTION EVIDENCE_DIR
)
readonly CUTOVER_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
CUTOVER_STARTED_SERVICES=0

print_command_plan() {
  printf '%s\n' \
    'preflight:ssh-source-package-file-runtime-node-separation' \
    'install:just-install-local' \
    'control-plane:dim-installer-install-control-plane' \
    'project:bootstrap-native-root,create-ready' \
    'workspace:create-schema9,proposal-push-denials' \
    'ci:native-root-admit-host,native-qemu-scheduler-admit-host' \
    'review:create,inspect,promote-denied,approve,promote-cas' \
    'cleanup:workspace-discard,started-services-stop,owned-claim-residue' \
    'evidence:credential-free-manifest,atomic-smoke-marker'
}

usage() {
  printf 'usage: %s [--preflight-only] /absolute/operator.conf\n       %s --print-command-plan\n' "$0" "$0" >&2
  exit 2
}

stop_started_services() {
  [[ "$CUTOVER_STARTED_SERVICES" -eq 1 ]] || return 0
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" systemctl --user stop \
    "${CUTOVER_CONFIG[QEMU_HOST_UNIT]}" "${CUTOVER_CONFIG[QEMU_SCHEDULER_UNIT]}" >/dev/null 2>&1 || true
  cutover_ssh "${CUTOVER_CONFIG[ORDINARY_SSH]}" systemctl --user stop \
    "${CUTOVER_CONFIG[ORDINARY_UNIT]}" >/dev/null 2>&1 || true
}

[[ "${1:-}" == --print-command-plan ]] && { [[ "$#" -eq 1 ]] || usage; print_command_plan; exit 0; }
preflight_only=0
if [[ "${1:-}" == --preflight-only ]]; then preflight_only=1; shift; fi
[[ "$#" -eq 1 ]] || usage
cutover_require_config "$1"
trap stop_started_services EXIT

for command in ssh jq stat sha256sum; do
  command -v "$command" >/dev/null || cutover_die "install required operator command '$command'" 2
done
[[ ! -e "${CUTOVER_CONFIG[EVIDENCE_DIR]}" && ! -L "${CUTOVER_CONFIG[EVIDENCE_DIR]}" ]] ||
  cutover_die "EVIDENCE_DIR must not already exist" 2

control_files=(
  "${CUTOVER_CONFIG[CONTROL_INSTALL_CONFIG]}" "${CUTOVER_CONFIG[REGISTRAR_CONNECTION]}"
  "${CUTOVER_CONFIG[IMPORTER_CONNECTION]}" "${CUTOVER_CONFIG[CONTROL_PLANE_CONNECTION]}"
  "${CUTOVER_CONFIG[ORDINARY_ADMISSION_CONFIG]}" "${CUTOVER_CONFIG[QEMU_SCHEDULER_CONFIG]}"
  "${CUTOVER_CONFIG[QEMU_HOST_CONFIG]}" "${CUTOVER_CONFIG[PROMOTER_CONNECTION]}"
  "${CUTOVER_CONFIG[REVIEWER_CONNECTION]}"
)
control_identity="$(cutover_remote_static_preflight "${CUTOVER_CONFIG[CONTROL_SSH]}" control-qemu \
  "${CUTOVER_CONFIG[CONTROL_SOURCE_ROOT]}" "${control_files[@]}")" ||
  cutover_die "control/QEMU prerequisite failed; repair SSH, source provenance, package preparation, files, Docker, or Compose" 2
ordinary_identity="$(cutover_remote_static_preflight "${CUTOVER_CONFIG[ORDINARY_SSH]}" ordinary \
  "${CUTOVER_CONFIG[ORDINARY_SOURCE_ROOT]}" "${CUTOVER_CONFIG[ORDINARY_HOST_CONFIG]}")" ||
  cutover_die "ordinary prerequisite failed; repair SSH, source provenance, package preparation, files, Docker, or Compose" 2
cutover_assert_node_separation "$control_identity" "$ordinary_identity"

cutover_remote_runtime_preflight "${CUTOVER_CONFIG[ORDINARY_SSH]}" ordinary \
  "${CUTOVER_CONFIG[ORDINARY_HOST_CONFIG]}" "${CUTOVER_CONFIG[ORDINARY_HOST_ID]}" >/dev/null ||
  cutover_die "ordinary runtime unavailable; install and register sysbox-runc, then rerun" 2
cutover_remote_runtime_preflight "${CUTOVER_CONFIG[CONTROL_SSH]}" qemu \
  "${CUTOVER_CONFIG[QEMU_HOST_CONFIG]}" "${CUTOVER_CONFIG[QEMU_HOST_ID]}" >/dev/null ||
  cutover_die "QEMU runtime unavailable; provide host KVM, pinned launcher images, and Docker type=image support" 2
cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" bash -s -- "${CUTOVER_CONFIG[PROJECT_SOURCE]}" \
  "${CUTOVER_CONFIG[PROJECT_REF]}" "${CUTOVER_CONFIG[PROJECT_COMMIT]}" \
  "${CUTOVER_CONFIG[QEMU_SCHEDULER_UNIT]}" "${CUTOVER_CONFIG[QEMU_HOST_UNIT]}" \
  "${CUTOVER_CONFIG[QEMU_SCHEDULER_CONFIG]}" "${CUTOVER_CONFIG[QEMU_HOST_ID]}" \
  "${CUTOVER_CONFIG[QEMU_HOST_CONFIG]}" <<'REMOTE' ||
set -euo pipefail
[[ "$(git -C "$1" rev-parse --verify "$2^{commit}")" == "$3" ]]
[[ -z "$(git -C "$1" status --porcelain=v1 --untracked-files=all)" ]]
! systemctl --user is-active --quiet "$4"
! systemctl --user is-active --quiet "$5"
systemctl --user cat "$4" | grep -F -- "dim ci native-qemu scheduler run $6" >/dev/null
systemctl --user cat "$5" | grep -F -- "dim ci native-qemu host run $7 $8" >/dev/null
REMOTE
  cutover_die "control source or service quiescence prerequisite failed; use a clean Project checkout and stop native QEMU units" 2
cutover_ssh "${CUTOVER_CONFIG[ORDINARY_SSH]}" bash -s -- "${CUTOVER_CONFIG[ORDINARY_UNIT]}" \
  "${CUTOVER_CONFIG[ORDINARY_HOST_CONFIG]}" <<'REMOTE' ||
set -euo pipefail
! systemctl --user is-active --quiet "$1"
systemctl --user cat "$1" | grep -F -- "dim ci native-root host run $2" >/dev/null
REMOTE
  cutover_die "ordinary unit must be stopped and use the configured host file" 2

if [[ "$preflight_only" -eq 1 ]]; then
  printf 'native-cutover-clean-host smoke prerequisites available: ordinary=sysbox-runc qemu=/dev/kvm,type=image nodes=separate protected-qemu=unused\n'
  exit 0
fi

umask 077
mkdir -m 700 -- "${CUTOVER_CONFIG[EVIDENCE_DIR]}"
evidence="${CUTOVER_CONFIG[EVIDENCE_DIR]}"
print_command_plan >"$evidence/command-plan.txt"
jq -cn --argjson control "$control_identity" --argjson ordinary "$ordinary_identity" \
  --arg ordinaryHost "${CUTOVER_CONFIG[ORDINARY_HOST_ID]}" --arg qemuHost "${CUTOVER_CONFIG[QEMU_HOST_ID]}" \
  '{schemaVersion:1,controlQemu:$control,ordinary:$ordinary,configuredHosts:{ordinary:$ordinaryHost,qemu:$qemuHost}}' \
  >"$evidence/nodes.json"

cutover_install_packages | tee "$evidence/package-install.log"
cutover_install_control_plane | tee "$evidence/control-plane-install.log"
cutover_create_project_workspace | tee "$evidence/project-workspace.jsonl"
proposal="$(cutover_create_proposal)"
printf '%s\n' "$proposal" >"$evidence/proposal.json"
CUTOVER_PROPOSAL_REF="$(jq -er '.proposalRef' <<<"$proposal")"
CUTOVER_CANDIDATE_COMMIT="$(jq -er '.candidateCommit' <<<"$proposal")"
CUTOVER_CANDIDATE_TREE="$(jq -er '.candidateTree' <<<"$proposal")"

cutover_admit_and_start_ci | tee "$evidence/ci-admission.log"
review="$(cutover_create_review)"
printf '%s\n' "$review" >"$evidence/review-create.json"
CUTOVER_REVIEW_ID="$(jq -er '.review.reviewId' <<<"$review")"
[[ "$(jq -er '.review.candidateCommit' <<<"$review")" == "$CUTOVER_CANDIDATE_COMMIT" ]]
[[ "$(jq -er '.review.candidateTree' <<<"$review")" == "$CUTOVER_CANDIDATE_TREE" ]]
cutover_inspect_review >"$evidence/review-inspect.json"
cutover_require_promotion_denial >"$evidence/protected-ref-before.txt"

terminal="$(cutover_wait_for_evidence)"
printf '%s\n' "$terminal" >"$evidence/terminal-evidence.json"
cutover_capture_image_evidence "$terminal" >"$evidence/images.json"
ordinary_digest="sha256:$(printf '%s\n' "${CUTOVER_CONFIG[ORDINARY_MARKER]}" | sha256sum | cut -d ' ' -f 1)"
qemu_digest="sha256:$(printf '%s\n' "${CUTOVER_CONFIG[QEMU_MARKER]}" | sha256sum | cut -d ' ' -f 1)"
jq -e --arg ordinary "$ordinary_digest" --arg qemu "$qemu_digest" \
  '.ordinary.event.payload.result == "success" and .ordinary.event.payload.stdout.sha256 == $ordinary and
   .ordinary.event.payload.stdout.truncated == false and .qemu.result == "success" and
   .qemu.event.payload.stdout.sha256 == $qemu and .qemu.event.payload.stdout.truncated == false' \
  <<<"$terminal" >/dev/null || cutover_die "terminal evidence did not match exact ordinary/QEMU marker digests"

printf 'Review %s for candidate %s and tree %s is ready.\n' "$CUTOVER_REVIEW_ID" \
  "$CUTOVER_CANDIDATE_COMMIT" "$CUTOVER_CANDIDATE_TREE" >&2
if [[ -t 0 ]]; then
  read -r -p 'Type the full candidate commit to approve and promote: ' confirmation
else
  cutover_die "review requires an operator TTY; rerun interactively after inspecting evidence" 2
fi
cutover_approve_promote "$confirmation" | tee "$evidence/approval-promotion.jsonl"
[[ "$(cutover_ref_value)" == "$CUTOVER_CANDIDATE_COMMIT" ]] || cutover_die "protected CAS result differs from candidate"
printf '%s\n' "$CUTOVER_CANDIDATE_COMMIT" >"$evidence/protected-ref-after.txt"
ledger="$(cutover_promotion_ledger)"
printf '%s\n' "$ledger" >"$evidence/promotion-ledger.json"
jq -e --arg commit "$CUTOVER_CANDIDATE_COMMIT" --arg tree "$CUTOVER_CANDIDATE_TREE" \
  '.intent == 0 and .finalized[-1].candidate_commit == $commit and .finalized[-1].candidate_tree == $tree' \
  <<<"$ledger" >/dev/null || cutover_die "durable promotion ledger does not match protected CAS"
cutover_refresh_protected_root >"$evidence/promoted-workspace.jsonl"
[[ "$(jq -sr '.[-1].rootCommit' "$evidence/promoted-workspace.jsonl")" == "$CUTOVER_CANDIDATE_COMMIT" ]] ||
  cutover_die "fresh protected-root workspace view does not name the promoted commit"

cutover_cleanup_remote
smoke_result_temporary="$evidence/.SMOKE-PASSED.$$.tmp"
jq -cn --arg commit "${CUTOVER_CONFIG[EXPECTED_COMMIT]}" --arg projectCommit "${CUTOVER_CONFIG[PROJECT_COMMIT]}" \
  --arg candidate "$CUTOVER_CANDIDATE_COMMIT" --arg tree "$CUTOVER_CANDIDATE_TREE" --arg review "$CUTOVER_REVIEW_ID" \
  '{schemaVersion:1,result:"smoke-passed",scope:"real-installed-multi-node-dual-kind-happy-path",
    softwareCommit:$commit,projectBaseCommit:$projectCommit,candidateCommit:$candidate,candidateTree:$tree,reviewId:$review,
    verified:["node-prerequisites","native-project-workspace","proposal-push-denials","ordinary-sysbox-success",
      "qemu-kvm-success","pre-approval-promotion-denial","human-approval","promotion-cas","owned-claim-cleanup"],
    notVerified:["empty-policy","ordinary-only-policy","qemu-only-policy","failed-result-denials","wrong-kind-denials",
      "foreign-or-stale-evidence-denials","replay-denials","crash-and-restart-recovery","guest-authority-inspection",
      "traffic-inspection","host-reboot-recovery"],workers:{ordinary:"ordinary-sysbox",qemu:"qemu"},
    cleanup:"owned-claims-clean",fullGate:"VERIFICATION-NATIVE-CUTOVER-001-not-satisfied",
    retainedState:"native Project and control-plane retained for explicit disposable-node destruction"}' \
  >"$smoke_result_temporary"
if grep -R -E '"(password|credential|token|authorization)"[[:space:]]*:' "$evidence" >/dev/null; then
  cutover_die "credential-bearing material reached the evidence directory"
fi
mv -- "$smoke_result_temporary" "$evidence/SMOKE-PASSED"
trap - EXIT
printf 'native-cutover-clean-host smoke passed review=%s candidate=%s tree=%s evidence=%s\n' \
  "$CUTOVER_REVIEW_ID" "$CUTOVER_CANDIDATE_COMMIT" "$CUTOVER_CANDIDATE_TREE" "$evidence"
