import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";

const exec = promisify(execFile);
const verificationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const evidenceLibrary = join(verificationRoot, "scripts", "lib", "native-multi-host-operations-evidence.bash");
const temporaryRoots = [];
const rootCommit = "a".repeat(40);
const candidateCommit = "b".repeat(40);
const candidateTree = "c".repeat(40);
const reviewId = "d".repeat(64);

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("reads exactly one bound schema-2 envelope and emits only a sanitized summary", async () => {
  const repository = await fixtureRepository();
  const proposalRef = "refs/heads/proposals/workspace/attempt-1";
  const envelope = envelopeRecord(proposalRef);
  await writeEnvelope(repository, `${reviewId}.${"e".repeat(64)}.json`, envelope);

  const result = await runEvidence("ops_read_envelope \"$PROPOSAL\"", repository, {
    PROPOSAL: JSON.stringify({ proposalRef, candidateCommit, candidateTree })
  });

  const summary = JSON.parse(result.stdout);
  assert.equal(summary.reviewId, reviewId);
  assert.equal(summary.expectedProtectedHead, rootCommit);
  assert.equal("patch" in summary, false);
  assert.equal("events" in summary, false);
});

test("rejects duplicate envelopes for the same proposal tuple", async () => {
  const repository = await fixtureRepository();
  const proposalRef = "refs/heads/proposals/workspace/attempt-1";
  const envelope = envelopeRecord(proposalRef);
  await writeEnvelope(repository, `${reviewId}.${"e".repeat(64)}.json`, envelope);
  await writeEnvelope(repository, `${reviewId}.${"f".repeat(64)}.json`, { ...envelope, envelopeId: "f".repeat(64) });

  const result = await runEvidenceFailure("ops_read_envelope \"$PROPOSAL\"", repository, {
    PROPOSAL: JSON.stringify({ proposalRef, candidateCommit, candidateTree })
  });

  assert.notEqual(result.code, 0);
});

test("accepts host/root/tree-bound untruncated dual terminal evidence and rejects a wrong host", async () => {
  const repository = await fixtureRepository();
  const ordinaryDigest = markerDigest("ordinary-output");
  const qemuDigest = markerDigest("qemu-output");
  const ordinaryRoot = join(repository, "dim-authoritative-statuses", "ordinary-sysbox", reviewId, "source");
  const qemuRoot = join(repository, "dim-authoritative-qemu");
  await mkdir(ordinaryRoot, { recursive: true });
  await mkdir(qemuRoot, { recursive: true });
  await writeFile(join(ordinaryRoot, "1.json"), JSON.stringify(terminal("ordinary-sysbox", "source", "ordinary-a", ordinaryDigest, "ordinary-attempt")));
  const qemuEvent = terminal("qemu", "integration", "qemu-a", qemuDigest, "qemu-attempt");
  await writeFile(join(qemuRoot, "state.json"), JSON.stringify({ schemaVersion: 1,
    attempts: [{ reviewId, attemptId: "qemu-attempt", descriptor: { jobName: "integration" } }],
    statuses: [{ schemaVersion: 1, attemptId: "qemu-attempt", result: "success", event: qemuEvent }] }));
  const envelope = JSON.stringify({ reviewId, candidateCommit, candidateTree, expectedProtectedHead: rootCommit });
  const environment = { ENVELOPE: envelope, ORDINARY_MARKER: "ordinary-output", QEMU_MARKER: "qemu-output" };
  const invocation = "ops_read_terminal_evidence \"$ENVELOPE\"";

  const success = await runEvidence(invocation, repository, environment);
  assert.deepEqual(Object.keys(JSON.parse(success.stdout)).sort(), ["ordinary", "qemu", "reviewId", "schemaVersion"]);

  const failure = await runEvidenceFailure(invocation, repository, { ...environment, ORDINARY_HOST_ID: "wrong-host" });
  assert.notEqual(failure.code, 0);
  qemuEvent.schemaVersion = 3;
  await writeFile(join(qemuRoot, "state.json"), JSON.stringify({ schemaVersion: 1,
    attempts: [{ reviewId, attemptId: "qemu-attempt", descriptor: { jobName: "integration" } }],
    statuses: [{ schemaVersion: 1, attemptId: "qemu-attempt", result: "success", event: qemuEvent }] }));
  const wrongSchema = await runEvidenceFailure(invocation, repository, environment);
  assert.notEqual(wrongSchema.code, 0);
});

test.each([
  ["ordinary-sysbox", "descriptor", undefined],
  ["ordinary-sysbox", "descriptor", null],
  ["ordinary-sysbox", "descriptor", "independent"],
  ["qemu", "descriptor", undefined],
  ["qemu", "descriptor", null],
  ["qemu", "descriptor", "independent"],
  ["qemu", "payload", undefined],
  ["qemu", "payload", null],
  ["qemu", "payload", "independent"]
])("rejects %s evidence with %s class %s", async (kind, location, value) => {
  const repository = await fixtureRepository();
  const ordinaryRoot = join(repository, "dim-authoritative-statuses", "ordinary-sysbox", reviewId, "source");
  const qemuRoot = join(repository, "dim-authoritative-qemu");
  await mkdir(ordinaryRoot, { recursive: true });
  await mkdir(qemuRoot, { recursive: true });
  const ordinary = terminal("ordinary-sysbox", "source", "ordinary-a", markerDigest("ordinary-output"), "ordinary-attempt");
  const qemu = terminal("qemu", "integration", "qemu-a", markerDigest("qemu-output"), "qemu-attempt");
  const event = kind === "qemu" ? qemu : ordinary;
  const target = location === "descriptor" ? event.payload.descriptor : event.payload;
  target.evidenceClass = value;
  await writeFile(join(ordinaryRoot, "1.json"), JSON.stringify(ordinary));
  await writeFile(join(qemuRoot, "state.json"), JSON.stringify({ schemaVersion: 1,
    attempts: [{ reviewId, attemptId: "qemu-attempt", descriptor: { jobName: "integration" } }],
    statuses: [{ schemaVersion: 1, attemptId: "qemu-attempt", result: "success", event: qemu }] }));

  const result = await runEvidenceFailure("ops_read_terminal_evidence \"$ENVELOPE\"", repository, {
    ENVELOPE: JSON.stringify({ reviewId, candidateCommit, candidateTree, expectedProtectedHead: rootCommit })
  });

  assert.equal(result.code, 2);
});

function envelopeRecord(proposalRef) {
  const jobs = [
    { executionKind: "ordinary-sysbox", jobName: "source", evidenceClass: "candidate-controlled" },
    { executionKind: "qemu", jobName: "integration", evidenceClass: "candidate-controlled" }
  ];
  return { schemaVersion: 2, envelopeId: "e".repeat(64), review: { schemaVersion: 2, reviewId,
    proposalRef, candidateCommit, candidateTree, expectedProtectedHead: rootCommit, protectedRef: "refs/heads/main",
    patch: "sensitive complete patch" }, planning: { status: "valid", jobs }, requiredJobs: jobs,
    events: jobs.map((job) => ({ schemaVersion: 3, type: "dim.native.review-job.available", ...job })) };
}

function terminal(kind, jobName, hostId, digest, attemptId) {
  return { schemaVersion: kind === "qemu" ? 1 : 3, eventId: `${kind}-event`, payload: { executionKind: kind, reviewId, attemptId,
    ...(kind === "qemu" ? { evidenceClass: "candidate-controlled" } : {}),
    hostId, result: "success", completion: { kind: "exited", exitCode: 0 },
    stdout: { sha256: digest, truncated: false }, stderr: { truncated: false },
    descriptor: { jobName, candidateCommit, candidateTree, expectedProtectedHead: rootCommit,
      evidenceClass: "candidate-controlled" } } };
}

async function fixtureRepository() {
  const root = await mkdtemp(join(tmpdir(), "dim-native-operations-evidence-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "dim-authoritative-reviews", "proposals"), { recursive: true });
  return root;
}

async function writeEnvelope(repository, name, value) {
  await writeFile(join(repository, "dim-authoritative-reviews", "proposals", name), JSON.stringify(value));
}

async function runEvidence(invocation, repository, extra = {}) {
  const driver = `
set -euo pipefail
source "$1"
declare -A OPS_CONFIG=([CONTROL_SSH]=control [NATIVE_GIT_CONTAINER]=native [PROJECT_ID]=project
  [PROJECT_COMMIT]="$3" [PROJECT_REF]=refs/heads/main [ORDINARY_JOB]=source [QEMU_JOB]=integration
  [ORDINARY_HOST_ID]="\${ORDINARY_HOST_ID:-ordinary-a}" [QEMU_HOST_ID]=qemu-a
  [ORDINARY_MARKER]="$4" [QEMU_MARKER]="$5")
TEST_REPOSITORY="$2"
ops_ssh() {
  shift
  arguments=("$@")
  [[ " \${arguments[*]} " == *' docker exec --interactive '* ]] || exit 90
  while [[ "$1" != node ]]; do shift; done
  arguments=("$@"); arguments[3]="$TEST_REPOSITORY"; "\${arguments[@]}"
}
${invocation}
`;
  return exec("bash", ["-c", driver, "bash", evidenceLibrary, repository, rootCommit,
    extra.ORDINARY_MARKER ?? "ordinary-output", extra.QEMU_MARKER ?? "qemu-output"], { env: { ...process.env, ...extra } });
}

async function runEvidenceFailure(invocation, repository, extra) {
  try { await runEvidence(invocation, repository, extra); } catch (error) {
    if (error instanceof Error && "code" in error) return error;
    throw error;
  }
  throw new Error("evidence read unexpectedly succeeded");
}

function markerDigest(marker) {
  return `sha256:${createHash("sha256").update(`${marker}\n`).digest("hex")}`;
}
