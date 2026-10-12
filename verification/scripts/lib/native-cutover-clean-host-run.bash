#!/usr/bin/env bash

cutover_install_packages() {
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" bash -s -- "${CUTOVER_CONFIG[CONTROL_SOURCE_ROOT]}" <<'REMOTE'
set -euo pipefail
cd -- "$1"
just install-local
REMOTE
  cutover_ssh "${CUTOVER_CONFIG[ORDINARY_SSH]}" bash -s -- "${CUTOVER_CONFIG[ORDINARY_SOURCE_ROOT]}" <<'REMOTE'
set -euo pipefail
cd -- "$1"
just install-local
REMOTE
}

cutover_install_control_plane() {
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" dim installer install control-plane --config \
    "${CUTOVER_CONFIG[CONTROL_INSTALL_CONFIG]}"
}

cutover_create_project_workspace() {
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" bash -s -- \
    "${CUTOVER_CONFIG[PROJECT_NAME]}" "${CUTOVER_CONFIG[PROJECT_ID]}" "${CUTOVER_CONFIG[PROJECT_SOURCE]}" \
    "${CUTOVER_CONFIG[PROJECT_REF]}" "${CUTOVER_CONFIG[PROJECT_COMMIT]}" \
    "${CUTOVER_CONFIG[REGISTRAR_CONNECTION]}" "${CUTOVER_CONFIG[IMPORTER_CONNECTION]}" \
    "${CUTOVER_CONFIG[CONTROL_PLANE_CONNECTION]}" "${CUTOVER_CONFIG[WORKSPACE_NAME]}" <<'REMOTE'
set -euo pipefail
project="$1"; project_id="$2"; source="$3"; ref="$4"; expected="$5"
registrar="$6"; importer="$7"; control="$8"; workspace="$9"
[[ "$(git -C "$source" rev-parse --verify "$ref^{commit}")" == "$expected" ]] || exit 1
[[ -z "$(git -C "$source" status --porcelain=v1 --untracked-files=all)" ]] || exit 1
dim project bootstrap-native-root "$project" --project-id "$project_id" --source-repository "$source" \
  --source-ref "$ref" --registrar-connection "$registrar" --importer-connection "$importer" \
  --git-executable /usr/bin/git --json
DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$control" DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE="$importer" \
  dim project create "$project" --json
DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$control" dim project show "$project" --json
DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$control" dim workspace create "$project" "$workspace"
DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$control" dim workspace show "$workspace" --json
REMOTE
}

cutover_create_proposal() {
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" bash -s -- \
    "${CUTOVER_CONFIG[CONTROL_PLANE_CONNECTION]}" "${CUTOVER_CONFIG[WORKSPACE_NAME]}" \
    "${CUTOVER_CONFIG[WORKSPACE_REPOSITORY]}" "$CUTOVER_RUN_ID" "${CUTOVER_CONFIG[PROJECT_ID]}" <<'REMOTE'
set -euo pipefail
control="$1"; workspace="$2"; repository="$3"; run_id="$4"; project_id="$5"
show="$(DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$control" dim workspace show "$workspace" --json)"
workspace_id="$(jq -er '.workspaceId' <<<"$show")"
proposal="refs/heads/proposals/$workspace_id/native-cutover-$run_id"
foreign="refs/heads/proposals/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/native-cutover-$run_id"
DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$control" dim workspace exec "$workspace" -- bash -s -- \
  "$repository" "$proposal" "$foreign" "$run_id" "$project_id" <<'INNER'
set -euo pipefail
repository="$1"; proposal="$2"; foreign="$3"; run_id="$4"; project_id="$5"
git -C "$repository" config user.name 'DIM native cutover'
git -C "$repository" config user.email 'native-cutover@dim.invalid'
git -C "$repository" switch -c "native-cutover-$run_id"
printf '%s\n' "$run_id" >"$repository/native-cutover-marker.txt"
git -C "$repository" add native-cutover-marker.txt
git -C "$repository" commit -m "native cutover $run_id" >/dev/null
candidate="$(git -C "$repository" rev-parse HEAD)"
tree="$(git -C "$repository" rev-parse 'HEAD^{tree}')"
git -C "$repository" push origin "HEAD:$proposal"
if git -C "$repository" push origin HEAD:refs/heads/main; then exit 41; fi
if git -C "$repository" push origin ":$proposal"; then exit 42; fi
if git -C "$repository" push origin "HEAD:$foreign"; then exit 43; fi
origin="$(git -C "$repository" remote get-url origin)"
foreign_origin="${origin/\/projects\/$project_id\//\/projects\/foreign-cutover\/}"
[[ "$foreign_origin" != "$origin" ]] || exit 45
if git -C "$repository" ls-remote "$foreign_origin" refs/heads/main; then exit 46; fi
printf 'force-denial\n' >>"$repository/native-cutover-marker.txt"
git -C "$repository" add native-cutover-marker.txt
git -C "$repository" commit --amend --no-edit >/dev/null
if git -C "$repository" push --force origin "HEAD:$proposal"; then exit 44; fi
git -C "$repository" reset --hard "$candidate" >/dev/null
jq -cn --arg workspaceId "${proposal#refs/heads/proposals/}" --arg proposal "$proposal" \
  --arg commit "$candidate" --arg tree "$tree" \
  '{workspaceId:($workspaceId|split("/")[0]),proposalRef:$proposal,candidateCommit:$commit,candidateTree:$tree}'
INNER
REMOTE
}

cutover_admit_and_start_ci() {
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" dim ci native-root project admit \
    "${CUTOVER_CONFIG[PROJECT_ID]}" "${CUTOVER_CONFIG[ORDINARY_ADMISSION_CONFIG]}"
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" dim ci native-qemu project admit \
    "${CUTOVER_CONFIG[PROJECT_ID]}" "${CUTOVER_CONFIG[QEMU_SCHEDULER_CONFIG]}"
  CUTOVER_STARTED_SERVICES=1
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" systemctl --user start \
    "${CUTOVER_CONFIG[QEMU_SCHEDULER_UNIT]}" "${CUTOVER_CONFIG[QEMU_HOST_UNIT]}"
  cutover_ssh "${CUTOVER_CONFIG[ORDINARY_SSH]}" systemctl --user start "${CUTOVER_CONFIG[ORDINARY_UNIT]}"
}

cutover_create_review() {
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" dim-native-git operator review create \
    "${CUTOVER_CONFIG[PROMOTER_CONNECTION]}" "${CUTOVER_CONFIG[PROJECT_ID]}" "$CUTOVER_PROPOSAL_REF"
}

cutover_inspect_review() {
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" dim-native-git operator review inspect \
    "${CUTOVER_CONFIG[REVIEWER_CONNECTION]}" "${CUTOVER_CONFIG[PROJECT_ID]}" "$CUTOVER_REVIEW_ID"
}

cutover_ref_value() {
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" docker exec --user 10001:10001 \
    "${CUTOVER_CONFIG[NATIVE_GIT_CONTAINER]}" git --git-dir \
    "/var/lib/dim-native-git/${CUTOVER_CONFIG[PROJECT_ID]}/root.git" rev-parse refs/heads/main
}

cutover_require_promotion_denial() {
  local before after
  before="$(cutover_ref_value)"
  if cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" dim-native-git operator review promote \
    "${CUTOVER_CONFIG[PROMOTER_CONNECTION]}" "${CUTOVER_CONFIG[PROJECT_ID]}" "$CUTOVER_REVIEW_ID"; then
    cutover_die "promotion succeeded before approval and terminal evidence"
  fi
  after="$(cutover_ref_value)"
  [[ "$before" == "$after" ]] || cutover_die "protected ref changed during denied promotion"
  printf '%s\n' "$before"
}

cutover_read_terminal_evidence() {
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" docker exec --user 10001:10001 \
    "${CUTOVER_CONFIG[NATIVE_GIT_CONTAINER]}" node --input-type=module - \
    "/var/lib/dim-native-git/${CUTOVER_CONFIG[PROJECT_ID]}/root.git" "$CUTOVER_REVIEW_ID" \
    "${CUTOVER_CONFIG[ORDINARY_JOB]}" "${CUTOVER_CONFIG[QEMU_JOB]}" <<'NODE'
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
const [repository, reviewId, ordinaryJob, qemuJob] = process.argv.slice(2);
const statusRoot = join(repository, "dim-authoritative-statuses", "ordinary-sysbox", reviewId, ordinaryJob);
const names = (await readdir(statusRoot)).filter((name) => /^[1-9][0-9]*\.json$/.test(name)).sort();
const ordinary = JSON.parse(await readFile(join(statusRoot, names.at(-1)), "utf8"));
const qemuState = JSON.parse(await readFile(join(repository, "dim-authoritative-qemu", "state.json"), "utf8"));
const qemuAttempt = [...qemuState.attempts].reverse().find((entry) => entry.reviewId === reviewId && entry.descriptor.jobName === qemuJob && entry.revokedAt === undefined);
const qemu = qemuState.statuses.find((entry) => entry.attemptId === qemuAttempt?.attemptId);
if (ordinary.payload?.descriptor?.jobName !== ordinaryJob || qemu === undefined) process.exit(2);
process.stdout.write(`${JSON.stringify({ ordinary: { event: ordinary }, qemu })}\n`);
NODE
}

cutover_wait_for_evidence() {
  local deadline=$((SECONDS + 1800)) evidence
  while (( SECONDS < deadline )); do
    if evidence="$(cutover_read_terminal_evidence 2>/dev/null)"; then printf '%s\n' "$evidence"; return; fi
    sleep 5
  done
  cutover_die "timed out waiting for ordinary and QEMU terminal evidence"
}

cutover_approve_promote() {
  local confirmation="$1"
  [[ "$confirmation" == "$CUTOVER_CANDIDATE_COMMIT" ]] || cutover_die "operator confirmation did not match candidate commit" 2
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" dim-native-git operator review approve \
    "${CUTOVER_CONFIG[REVIEWER_CONNECTION]}" "${CUTOVER_CONFIG[PROJECT_ID]}" "$CUTOVER_REVIEW_ID"
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" dim-native-git operator review promote \
    "${CUTOVER_CONFIG[PROMOTER_CONNECTION]}" "${CUTOVER_CONFIG[PROJECT_ID]}" "$CUTOVER_REVIEW_ID"
}

cutover_cleanup_remote() {
  cutover_ssh "${CUTOVER_CONFIG[CONTROL_SSH]}" bash -s -- "${CUTOVER_CONFIG[CONTROL_PLANE_CONNECTION]}" \
    "${CUTOVER_CONFIG[WORKSPACE_NAME]}" "${CUTOVER_CONFIG[QEMU_HOST_UNIT]}" \
    "${CUTOVER_CONFIG[QEMU_SCHEDULER_UNIT]}" <<'REMOTE'
set -euo pipefail
DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE="$1" dim workspace discard "$2" --yes
systemctl --user stop "$3" "$4"
[[ -z "$(docker container ls --all --quiet --filter label=dev.dim.native-qemu.claim)" ]]
shopt -s nullglob
qemu_residue=(/var/lib/dim-native-qemu-host/*/journal.json /var/lib/dim-native-qemu-host/*/*/)
[[ "${#qemu_residue[@]}" -eq 0 ]]
REMOTE
  cutover_ssh "${CUTOVER_CONFIG[ORDINARY_SSH]}" bash -s -- "${CUTOVER_CONFIG[ORDINARY_UNIT]}" \
    "${CUTOVER_CONFIG[ORDINARY_STATE_DIRECTORY]}" <<'REMOTE'
set -euo pipefail
systemctl --user stop "$1"
[[ -z "$(docker container ls --all --quiet --filter label=dim.kind=native-ordinary-runner)" ]]
shopt -s nullglob
ordinary_residue=("$2"/*.json "$2"/work-* "$2"/.work-*.staging)
[[ "${#ordinary_residue[@]}" -eq 0 ]]
REMOTE
  CUTOVER_STARTED_SERVICES=0
}
