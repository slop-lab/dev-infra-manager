#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/lib/native-cutover-clean-host-common.bash"
source "$script_dir/lib/native-cutover-clean-host-run.bash"
source "$script_dir/lib/native-cutover-clean-host-evidence.bash"
source "$script_dir/lib/native-cutover-policy-matrix-run.bash"

readonly CUTOVER_DIAGNOSTIC_NAME=native-cutover-policy-matrix
declare -A CUTOVER_CONFIG=()
readonly MATRIX_PROFILES=(empty ordinary qemu dual)
readonly MATRIX_SHARED_KEYS=(
  CONTROL_SSH ORDINARY_SSH EXPECTED_COMMIT CONTROL_SOURCE_ROOT ORDINARY_SOURCE_ROOT
  CONTROL_INSTALL_CONFIG REGISTRAR_CONNECTION IMPORTER_CONNECTION CONTROL_PLANE_CONNECTION
  ORDINARY_HOST_CONFIG ORDINARY_HOST_ID ORDINARY_UNIT ORDINARY_STATE_DIRECTORY
  QEMU_SCHEDULER_CONFIG QEMU_HOST_CONFIG QEMU_HOST_ID QEMU_SCHEDULER_UNIT QEMU_HOST_UNIT
  PROMOTER_CONNECTION REVIEWER_CONNECTION NATIVE_GIT_CONTAINER ORDINARY_CI_CONTAINER
  ORDINARY_JOB QEMU_JOB ORDINARY_MARKER QEMU_MARKER EVIDENCE_DIR PROTECTED_QEMU_MODE
)
readonly MATRIX_PROFILE_SUFFIXES=(
  PROJECT_NAME PROJECT_ID PROJECT_SOURCE PROJECT_REF PROJECT_COMMIT WORKSPACE_NAME WORKSPACE_REPOSITORY
)
CUTOVER_REQUIRED_KEYS=("${MATRIX_SHARED_KEYS[@]}")
for matrix_profile in "${MATRIX_PROFILES[@]}"; do
  for matrix_suffix in "${MATRIX_PROFILE_SUFFIXES[@]}"; do
    CUTOVER_REQUIRED_KEYS+=("${matrix_profile^^}_${matrix_suffix}")
  done
done
readonly CUTOVER_REQUIRED_KEYS
readonly CUTOVER_ALL_KEYS=("${CUTOVER_REQUIRED_KEYS[@]}")
CUTOVER_PATH_KEYS=(
  CONTROL_SOURCE_ROOT ORDINARY_SOURCE_ROOT CONTROL_INSTALL_CONFIG REGISTRAR_CONNECTION
  IMPORTER_CONNECTION CONTROL_PLANE_CONNECTION ORDINARY_HOST_CONFIG
  ORDINARY_STATE_DIRECTORY QEMU_SCHEDULER_CONFIG QEMU_HOST_CONFIG PROMOTER_CONNECTION
  REVIEWER_CONNECTION EVIDENCE_DIR
)
CUTOVER_COMMIT_KEYS=(EXPECTED_COMMIT)
CUTOVER_IDENTIFIER_KEYS=(ORDINARY_HOST_ID QEMU_HOST_ID ORDINARY_JOB QEMU_JOB)
for matrix_profile in "${MATRIX_PROFILES[@]}"; do
  matrix_prefix="${matrix_profile^^}"
  CUTOVER_PATH_KEYS+=("${matrix_prefix}_PROJECT_SOURCE" "${matrix_prefix}_WORKSPACE_REPOSITORY")
  CUTOVER_COMMIT_KEYS+=("${matrix_prefix}_PROJECT_COMMIT")
  CUTOVER_IDENTIFIER_KEYS+=(
    "${matrix_prefix}_PROJECT_NAME" "${matrix_prefix}_PROJECT_ID" "${matrix_prefix}_WORKSPACE_NAME"
  )
done
readonly CUTOVER_PATH_KEYS CUTOVER_COMMIT_KEYS CUTOVER_IDENTIFIER_KEYS
readonly CUTOVER_UNIT_KEYS=(ORDINARY_UNIT QEMU_SCHEDULER_UNIT QEMU_HOST_UNIT)
readonly CUTOVER_CONTAINER_KEYS=(NATIVE_GIT_CONTAINER ORDINARY_CI_CONTAINER)
readonly MATRIX_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
CUTOVER_RUN_ID="$MATRIX_RUN_ID"
CUTOVER_STARTED_ORDINARY=0
CUTOVER_STARTED_QEMU_SCHEDULER=0
CUTOVER_STARTED_QEMU_HOST=0
MATRIX_ORDINARY_CI_RESTORE_REQUIRED=0
MATRIX_ORDINARY_CI_CONTAINER_ID=""
MATRIX_ORDINARY_CI_STATE_SHA256=""
MATRIX_WORKSPACE_CREATED=0
CUTOVER_PROFILE=""

print_command_plan() {
  printf '%s\n' \
    'preflight:ssh-source-snapshots-package-files-runtime-node-separation-no-mutation' \
    'install:just-install-local,dim-installer-install-control-plane' \
    'profile-empty:owned-ordinary-readiness-outage,restore,start-all-ci,proposal-autoqueue,resolve,approve,promotion-cas,all-results,cleanup' \
    'profile-ordinary:start-all-ci,proposal-autoqueue,ordinary-quality,resolve,required-result,approve,promotion-cas,all-results,cleanup' \
    'profile-qemu:owned-ordinary-readiness-outage,restore,start-all-ci,proposal-autoqueue,qemu-quality,resolve,required-result,approve,promotion-cas,all-results,cleanup' \
    'profile-dual:start-all-ci,proposal-autoqueue,dual-quality,resolve,required-results,approve,promotion-cas,all-results,cleanup' \
    'evidence:envelope2-events3,executedJobs,qualityRequiredJobs,owned-central-state,protected-cas,atomic-markers' \
    'preparation:fault-recovery,authority,traffic-explicitly-deferred' \
    'deferred:fault-authority-traffic-recovery-independent-host-execution'
}

usage() {
  printf 'usage: %s [--preflight-only] /absolute/operator.conf\n       %s --print-command-plan\n' "$0" "$0" >&2
  exit 2
}

matrix_require_unique_values() {
  local suffix profile prefix value
  declare -A seen=()
  for suffix in PROJECT_NAME PROJECT_ID WORKSPACE_NAME; do
    seen=()
    for profile in "${MATRIX_PROFILES[@]}"; do
      prefix="${profile^^}"
      value="${CUTOVER_CONFIG[${prefix}_${suffix}]}"
      [[ -z "${seen[$value]+x}" ]] || cutover_die "matrix $suffix values must be pairwise distinct" 2
      seen[$value]=1
    done
  done
  for profile in "${MATRIX_PROFILES[@]}"; do
    prefix="${profile^^}"
    [[ "${CUTOVER_CONFIG[${prefix}_PROJECT_REF]}" =~ ^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] ||
      cutover_die "${prefix}_PROJECT_REF must be a full branch ref" 2
  done
  [[ "${CUTOVER_CONFIG[ORDINARY_CI_CONTAINER]}" == dim-control-plane-ordinary-ci-1 ]] ||
    cutover_die "ORDINARY_CI_CONTAINER must name the fixed installed ordinary-ci service" 2
}

matrix_emergency_cleanup() {
  local original_status=$? cleanup_failed=0
  trap - EXIT
  set +e
  matrix_stop_global_ci || cleanup_failed=1
  if [[ "$MATRIX_WORKSPACE_CREATED" -eq 1 ]]; then
    cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" env \
      "DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE=${CUTOVER_CONFIG[CONTROL_PLANE_CONNECTION]}" \
      dim workspace discard "${CUTOVER_CONFIG[WORKSPACE_NAME]}" --yes >/dev/null 2>&1 || cleanup_failed=1
  fi
  if [[ "$MATRIX_ORDINARY_CI_RESTORE_REQUIRED" -eq 1 ]]; then
    matrix_restore_owned_ordinary_ci >/dev/null || cleanup_failed=1
  fi
  if [[ "$cleanup_failed" -ne 0 ]]; then
    printf 'native-cutover-policy-matrix: emergency cleanup or ordinary service restore failed\n' >&2
    exit 1
  fi
  exit "$original_status"
}

matrix_run_profile() {
  local profile="$1" profile_evidence="$evidence/$profile"
  local central_service_evidence='{"mode":"owned-running"}'
  matrix_select_profile "$profile"
  install -d -m 700 -- "$profile_evidence"
  if [[ "$profile" == empty || "$profile" == qemu ]]; then
    matrix_stop_owned_ordinary_ci >"$profile_evidence/ordinary-ci-stop.json"
    matrix_assert_owned_ordinary_ci_stopped >"$profile_evidence/ordinary-ci-stopped-before-create.json"
  fi
  cutover_create_project_workspace >"$profile_evidence/project-workspace.jsonl"
  MATRIX_WORKSPACE_CREATED=1
  if [[ "$profile" == empty || "$profile" == qemu ]]; then
    matrix_assert_owned_ordinary_ci_stopped >"$profile_evidence/ordinary-ci-stopped-at-readiness.json"
  fi
  matrix_assert_ready_ci_stopped >"$profile_evidence/readiness-ci-stopped.jsonl"
  if [[ "$profile" == empty || "$profile" == qemu ]]; then
    matrix_restore_owned_ordinary_ci >"$profile_evidence/ordinary-ci-restore-before-ci.json"
    central_service_evidence="$(jq -cn --arg id "$MATRIX_ORDINARY_CI_CONTAINER_ID" \
      --arg stateSha256 "$MATRIX_ORDINARY_CI_STATE_SHA256" \
      '{mode:"owned-readiness-outage-restored",containerId:$id,stateSha256:$stateSha256}')"
  else
    matrix_assert_owned_ordinary_ci_running >"$profile_evidence/ordinary-ci-running-before-ci.json"
  fi
  matrix_start_global_ci >"$profile_evidence/global-ci-start.log"
  proposal="$(cutover_create_proposal)"
  printf '%s\n' "$proposal" >"$profile_evidence/proposal.json"
  CUTOVER_PROPOSAL_REF="$(jq -er '.proposalRef' <<<"$proposal")"
  CUTOVER_CANDIDATE_COMMIT="$(jq -er '.candidateCommit' <<<"$proposal")"
  CUTOVER_CANDIDATE_TREE="$(jq -er '.candidateTree' <<<"$proposal")"

  review="$(cutover_resolve_review)"
  printf '%s\n' "$review" >"$profile_evidence/review-resolve.json"
  CUTOVER_REVIEW_ID="$(jq -er '.review.reviewId' <<<"$review")"
  [[ "$(jq -er '.review.candidateCommit' <<<"$review")" == "$CUTOVER_CANDIDATE_COMMIT" ]]
  [[ "$(jq -er '.review.candidateTree' <<<"$review")" == "$CUTOVER_CANDIDATE_TREE" ]]
  matrix_assert_review_profile "$profile" "$review"
  cutover_inspect_review >"$profile_evidence/review-inspect.json"
  cutover_require_promotion_denial >"$profile_evidence/protected-ref-before.txt"
  quality_terminal="$(matrix_wait_for_evidence_scope matrix_assert_quality_evidence "$profile")"
  printf '%s\n' "$quality_terminal" >"$profile_evidence/quality-required-evidence-at-promotion.json"

  printf 'Review %s (%s) for candidate %s and tree %s is ready.\n' "$CUTOVER_REVIEW_ID" "$profile" \
    "$CUTOVER_CANDIDATE_COMMIT" "$CUTOVER_CANDIDATE_TREE" >&2
  if [[ -t 0 ]]; then
    read -r -p "Type the full $profile candidate commit to approve and promote: " confirmation
  else
    cutover_die "$profile review requires an operator TTY; rerun interactively after inspecting evidence" 2
  fi
  cutover_approve_promote "$confirmation" >"$profile_evidence/approval-promotion.jsonl"
  ref_state="$(matrix_ref_state)"
  printf '%s\n' "$ref_state" >"$profile_evidence/protected-ref-after.json"
  [[ "$(jq -er '.commit' <<<"$ref_state")" == "$CUTOVER_CANDIDATE_COMMIT" ]]
  [[ "$(jq -er '.tree' <<<"$ref_state")" == "$CUTOVER_CANDIDATE_TREE" ]]
  ledger="$(cutover_promotion_ledger)"
  printf '%s\n' "$ledger" >"$profile_evidence/promotion-ledger.json"
  jq -e --arg commit "$CUTOVER_CANDIDATE_COMMIT" --arg tree "$CUTOVER_CANDIDATE_TREE" \
    '.intent == 0 and .finalized[-1].candidate_commit == $commit and .finalized[-1].candidate_tree == $tree' \
    <<<"$ledger" >/dev/null || cutover_die "$profile durable promotion ledger differs from protected CAS"
  executed_terminal="$(matrix_wait_for_evidence_scope matrix_assert_executed_evidence "$profile")"
  printf '%s\n' "$executed_terminal" >"$profile_evidence/executed-job-evidence.json"
  matrix_capture_executed_images "$executed_terminal" >"$profile_evidence/images.json"

  matrix_cleanup_profile
  profile_result_temporary="$profile_evidence/.PROFILE-PASSED.$$.tmp"
  jq -cn --arg profile "$profile" --arg source "${CUTOVER_CONFIG[PROJECT_SOURCE]}" \
    --arg sourceRef "${CUTOVER_CONFIG[PROJECT_REF]}" --arg sourceCommit "${CUTOVER_CONFIG[PROJECT_COMMIT]}" \
    --arg sourceTree "$(jq -er --arg profile "$profile" '.[] | select(.profile == $profile) | .tree' <<<"$profile_sources")" \
    --arg proposalRef "$CUTOVER_PROPOSAL_REF" --arg candidate "$CUTOVER_CANDIDATE_COMMIT" \
    --arg tree "$CUTOVER_CANDIDATE_TREE" --arg review "$CUTOVER_REVIEW_ID" --argjson protectedRef "$ref_state" \
    --argjson centralService "$central_service_evidence" \
    --argjson executedJobs "$(jq -c '[.planning.jobs[] | {executionKind,jobName,evidenceClass}]' <<<"$review")" \
    --argjson qualityRequiredJobs "$(jq -c '.requiredJobs' <<<"$review")" \
    '{schemaVersion:1,result:"profile-passed",profile:$profile,source:{path:$source,ref:$sourceRef,commit:$sourceCommit,tree:$sourceTree},
      proposalRef:$proposalRef,candidateCommit:$candidate,candidateTree:$tree,reviewId:$review,protectedRef:$protectedRef,
      contracts:{reviewEnvelopeSchema:2,reviewEventSchema:3,ordinaryConfigSchema:5,ordinaryStateFormat:12,
        qemuConfigSchema:2,qemuDatabaseSchema:3},
      centralService:$centralService,executedJobs:$executedJobs,qualityRequiredJobs:$qualityRequiredJobs,
      cleanup:"exact-workspace-and-global-owned-claims-clean",retainedState:"native Project retained for disposable-node destruction",
      fullGate:"VERIFICATION-NATIVE-CUTOVER-001-not-satisfied"}' >"$profile_result_temporary"
  mv -- "$profile_result_temporary" "$profile_evidence/PROFILE-PASSED"
}

[[ "${1:-}" == --print-command-plan ]] && { [[ "$#" -eq 1 ]] || usage; print_command_plan; exit 0; }
preflight_only=0
if [[ "${1:-}" == --preflight-only ]]; then preflight_only=1; shift; fi
[[ "$#" -eq 1 ]] || usage
cutover_require_config "$1"
matrix_require_unique_values
trap matrix_emergency_cleanup EXIT

for command in ssh jq stat sha256sum; do
  command -v "$command" >/dev/null || cutover_die "install required operator command '$command'" 2
done
[[ ! -e "${CUTOVER_CONFIG[EVIDENCE_DIR]}" && ! -L "${CUTOVER_CONFIG[EVIDENCE_DIR]}" ]] ||
  cutover_die "EVIDENCE_DIR must not already exist" 2

control_files=(
  "${CUTOVER_CONFIG[CONTROL_INSTALL_CONFIG]}" "${CUTOVER_CONFIG[REGISTRAR_CONNECTION]}"
  "${CUTOVER_CONFIG[IMPORTER_CONNECTION]}" "${CUTOVER_CONFIG[CONTROL_PLANE_CONNECTION]}"
  "${CUTOVER_CONFIG[QEMU_SCHEDULER_CONFIG]}"
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
profile_sources="$(matrix_profile_source_preflight)" ||
  cutover_die "profile source snapshot or service quiescence prerequisite failed" 2
jq -e 'length == 4 and ([.[].profile] | sort == ["dual","empty","ordinary","qemu"]) and
  all(.[]; (.tree | test("^[0-9a-f]{40}$")))' <<<"$profile_sources" >/dev/null ||
  cutover_die "profile source prerequisite returned invalid evidence" 2

if [[ "$preflight_only" -eq 1 ]]; then
  printf 'native-cutover policy matrix prerequisites available: profiles=empty,ordinary,qemu,dual nodes=separate mutation=none\n'
  trap - EXIT
  exit 0
fi

umask 077
mkdir -m 700 -- "${CUTOVER_CONFIG[EVIDENCE_DIR]}"
evidence="${CUTOVER_CONFIG[EVIDENCE_DIR]}"
print_command_plan >"$evidence/command-plan.txt"
cutover_deferred_phase_manifest >"$evidence/deferred-phase-preparation.json"
jq -cn --argjson control "$control_identity" --argjson ordinary "$ordinary_identity" \
  --arg ordinaryHost "${CUTOVER_CONFIG[ORDINARY_HOST_ID]}" --arg qemuHost "${CUTOVER_CONFIG[QEMU_HOST_ID]}" \
  '{schemaVersion:1,controlQemu:$control,ordinary:$ordinary,configuredHosts:{ordinary:$ordinaryHost,qemu:$qemuHost}}' \
  >"$evidence/nodes.json"
printf '%s\n' "$profile_sources" >"$evidence/profile-sources.json"
cutover_install_packages >"$evidence/package-install.log"
cutover_install_control_plane >"$evidence/control-plane-install.log"
for matrix_profile in "${MATRIX_PROFILES[@]}"; do matrix_run_profile "$matrix_profile"; done

profile_results="$(jq -sc '.' \
  "$evidence/empty/PROFILE-PASSED" "$evidence/ordinary/PROFILE-PASSED" \
  "$evidence/qemu/PROFILE-PASSED" "$evidence/dual/PROFILE-PASSED")"
jq -e 'length == 4 and ([.[].profile] == ["empty","ordinary","qemu","dual"]) and
  all(.[]; .result == "profile-passed" and .fullGate == "VERIFICATION-NATIVE-CUTOVER-001-not-satisfied" and
    (.source.commit | test("^[0-9a-f]{40}$")) and (.source.tree | test("^[0-9a-f]{40}$")) and
    (.candidateCommit | test("^[0-9a-f]{40}$")) and (.candidateTree | test("^[0-9a-f]{40}$")) and
    .protectedRef.commit == .candidateCommit and .protectedRef.tree == .candidateTree and
    [.executedJobs[].executionKind] == ["ordinary-sysbox","qemu"]) and
  .[0].qualityRequiredJobs == [] and [.[1].qualityRequiredJobs[].executionKind] == ["ordinary-sysbox"] and
  [.[2].qualityRequiredJobs[].executionKind] == ["qemu"] and
  [.[3].qualityRequiredJobs[].executionKind] == ["ordinary-sysbox","qemu"]' \
  <<<"$profile_results" >/dev/null || cutover_die "profile result manifests are missing or inconsistent"
matrix_result_temporary="$evidence/.MATRIX-PASSED.$$.tmp"
jq -cn --arg commit "${CUTOVER_CONFIG[EXPECTED_COMMIT]}" --argjson profileResults "$profile_results" \
  '{schemaVersion:1,result:"matrix-passed",scope:"real-installed-four-quality-policy-happy-paths",
    softwareCommit:$commit,profiles:["empty","ordinary","qemu","dual"],profileResults:$profileResults,
    contracts:{reviewEnvelopeSchema:2,reviewEventSchema:3,ordinaryConfigSchema:5,ordinaryStateFormat:12,
      qemuConfigSchema:2,qemuDatabaseSchema:3},
    verified:["ready-before-global-ci","owned-ordinary-readiness-outage-state-preservation",
      "automatic-envelope2-events3-all-job-queue","empty-quality-no-result-wait",
      "ordinary-quality-required-subset","qemu-quality-required-subset","dual-quality-required-subset",
      "all-candidate-jobs-executed","interactive-human-approval","promotion-cas","per-profile-owned-cleanup"],
    notVerified:["fault-result-denials","stale-and-replay-denials","crash-and-restart-recovery",
      "guest-authority-inspection","traffic-inspection","host-reboot-recovery","independent-host-execution"],
    fullGate:"VERIFICATION-NATIVE-CUTOVER-001-not-satisfied",
    retainedState:"four native Projects and control-plane retained for explicit disposable-node destruction"}' \
  >"$matrix_result_temporary"
if grep -R -E '"(password|credential|token|authorization)"[[:space:]]*:' "$evidence" >/dev/null; then
  cutover_die "credential-bearing material reached the evidence directory"
fi
mv -- "$matrix_result_temporary" "$evidence/MATRIX-PASSED"
trap - EXIT
printf 'native-cutover policy matrix passed profiles=empty,ordinary,qemu,dual evidence=%s full-gate=not-satisfied\n' "$evidence"
