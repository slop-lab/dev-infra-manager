#!/usr/bin/env bash

ops_read_envelope() {
  local proposal="$1"
  ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" docker exec --interactive --user 10001:10001 \
    "${OPS_CONFIG[NATIVE_GIT_CONTAINER]}" node --input-type=module - \
    "/var/lib/dim-native-git/${OPS_CONFIG[PROJECT_ID]}/root.git" \
    "$(jq -er '.proposalRef' <<<"$proposal")" "$(jq -er '.candidateCommit' <<<"$proposal")" \
    "$(jq -er '.candidateTree' <<<"$proposal")" "${OPS_CONFIG[PROJECT_COMMIT]}" \
    "${OPS_CONFIG[PROJECT_REF]}" "${OPS_CONFIG[ORDINARY_JOB]}" "${OPS_CONFIG[QEMU_JOB]}" <<'NODE'
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
const [repository, proposalRef, candidateCommit, candidateTree, expectedRoot, protectedRef, ordinaryJob, qemuJob] = process.argv.slice(2);
const root = join(repository, "dim-authoritative-reviews", "proposals");
const matches = [];
for (const name of await readdir(root)) {
  if (!/^[0-9a-f]{64}\.[0-9a-f]{64}\.json$/.test(name)) continue;
  const envelope = JSON.parse(await readFile(join(root, name), "utf8"));
  const review = envelope.review;
  if (envelope.schemaVersion === 2 && review?.schemaVersion === 2 && review.proposalRef === proposalRef
    && review.candidateCommit === candidateCommit && review.candidateTree === candidateTree
    && review.expectedProtectedHead === expectedRoot && review.protectedRef === protectedRef) matches.push(envelope);
}
if (matches.length !== 1) process.exit(2);
const envelope = matches[0];
const planned = envelope.planning?.status === "valid" ? envelope.planning.jobs : [];
const expected = [
  { executionKind: "ordinary-sysbox", jobName: ordinaryJob, evidenceClass: "candidate-controlled" },
  { executionKind: "qemu", jobName: qemuJob, evidenceClass: "candidate-controlled" }
];
const identities = planned.map(({ executionKind, jobName, evidenceClass }) => ({ executionKind, jobName, evidenceClass }));
const events = envelope.events?.map(({ schemaVersion, type, executionKind, jobName, evidenceClass }) =>
  ({ schemaVersion, type, executionKind, jobName, evidenceClass }));
if (JSON.stringify(identities) !== JSON.stringify(expected)
  || JSON.stringify(envelope.requiredJobs) !== JSON.stringify(expected)
  || events?.length !== 2 || events.some((event, index) => event.schemaVersion !== 3
    || event.type !== "dim.native.review-job.available"
    || JSON.stringify({ executionKind: event.executionKind, jobName: event.jobName, evidenceClass: event.evidenceClass })
      !== JSON.stringify(expected[index]))) process.exit(2);
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, envelopeId: envelope.envelopeId,
  reviewId: envelope.review.reviewId, proposalRef, candidateCommit, candidateTree,
  expectedProtectedHead: expectedRoot, protectedRef, jobs: expected })}\n`);
NODE
}

ops_read_terminal_evidence() {
  local envelope="$1" ordinary_digest qemu_digest
  ordinary_digest="sha256:$(printf '%s\n' "${OPS_CONFIG[ORDINARY_MARKER]}" | sha256sum | cut -d ' ' -f 1)"
  qemu_digest="sha256:$(printf '%s\n' "${OPS_CONFIG[QEMU_MARKER]}" | sha256sum | cut -d ' ' -f 1)"
  ops_ssh "${OPS_CONFIG[CONTROL_SSH]}" docker exec --interactive --user 10001:10001 \
    "${OPS_CONFIG[NATIVE_GIT_CONTAINER]}" node --input-type=module - \
    "/var/lib/dim-native-git/${OPS_CONFIG[PROJECT_ID]}/root.git" \
    "$(jq -er '.reviewId' <<<"$envelope")" "$(jq -er '.candidateCommit' <<<"$envelope")" \
    "$(jq -er '.candidateTree' <<<"$envelope")" "$(jq -er '.expectedProtectedHead' <<<"$envelope")" \
    "${OPS_CONFIG[ORDINARY_JOB]}" "${OPS_CONFIG[QEMU_JOB]}" "${OPS_CONFIG[ORDINARY_HOST_ID]}" \
    "${OPS_CONFIG[QEMU_HOST_ID]}" "$ordinary_digest" "$qemu_digest" <<'NODE'
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
const [repository, reviewId, candidateCommit, candidateTree, expectedRoot, ordinaryJob, qemuJob,
  ordinaryHost, qemuHost, ordinaryDigest, qemuDigest] = process.argv.slice(2);
const valid = (event, kind, job, host, digest) => event?.schemaVersion === (kind === "qemu" ? 1 : 3)
  && event.payload?.executionKind === kind && event.payload?.reviewId === reviewId
  && event.payload?.descriptor?.evidenceClass === "candidate-controlled"
  && (kind !== "qemu" || event.payload?.evidenceClass === "candidate-controlled")
  && event.payload?.hostId === host && event.payload?.result === "success"
  && event.payload?.completion?.kind === "exited" && event.payload?.completion?.exitCode === 0
  && event.payload?.stdout?.sha256 === digest && event.payload?.stdout?.truncated === false
  && event.payload?.stderr?.truncated === false && event.payload?.descriptor?.jobName === job
  && event.payload?.descriptor?.candidateCommit === candidateCommit
  && event.payload?.descriptor?.candidateTree === candidateTree
  && event.payload?.descriptor?.expectedProtectedHead === expectedRoot;
const ordinaryRoot = join(repository, "dim-authoritative-statuses", "ordinary-sysbox", reviewId, ordinaryJob);
const names = (await readdir(ordinaryRoot)).filter((name) => /^[1-9][0-9]*\.json$/.test(name))
  .sort((left, right) => Number.parseInt(left) - Number.parseInt(right));
if (names.length === 0) process.exit(2);
const ordinary = JSON.parse(await readFile(join(ordinaryRoot, names.at(-1)), "utf8"));
const qemuState = JSON.parse(await readFile(join(repository, "dim-authoritative-qemu", "state.json"), "utf8"));
const attempts = qemuState.attempts.filter((entry) => entry.reviewId === reviewId
  && entry.descriptor?.jobName === qemuJob && entry.revokedAt === undefined);
if (qemuState.schemaVersion !== 1 || attempts.length !== 1) process.exit(2);
const qemuAttempt = attempts[0];
const statuses = qemuState.statuses.filter((entry) => entry.attemptId === qemuAttempt.attemptId);
if (statuses.length !== 1 || statuses[0].schemaVersion !== 1 || statuses[0].result !== "success"
  || !valid(ordinary, "ordinary-sysbox", ordinaryJob, ordinaryHost, ordinaryDigest)
  || !valid(statuses[0].event, "qemu", qemuJob, qemuHost, qemuDigest)
  || statuses[0].event.payload.attemptId !== qemuAttempt.attemptId) process.exit(2);
const summary = (event) => ({ eventId: event.eventId, attemptId: event.payload.attemptId,
  hostId: event.payload.hostId, kind: event.payload.executionKind, job: event.payload.descriptor.jobName,
  result: event.payload.result, markerSha256: event.payload.stdout.sha256 });
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, reviewId,
  ordinary: summary(ordinary), qemu: summary(statuses[0].event) })}\n`);
NODE
}

ops_wait_terminal_evidence() {
  local envelope="$1" deadline=$((SECONDS + 1800)) result
  while ((SECONDS < deadline)); do
    if result="$(ops_read_terminal_evidence "$envelope" 2>/dev/null)"; then
      printf '%s\n' "$result"
      return
    fi
    sleep 5
  done
  ops_die 'timed out waiting for exact ordinary and QEMU terminal evidence'
}
