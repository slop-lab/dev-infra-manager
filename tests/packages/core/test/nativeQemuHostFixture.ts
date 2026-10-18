import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { nativeQemuDescriptorDigest, type NativeQemuDescriptor,
  type NativeQemuHostAssignment } from "../../../../core/packages/managed/src/nativeQemuAssignment.js";
import type { NativeCandidateReadAuthority } from "../../../../core/packages/managed/src/nativeOrdinaryCandidateVerifier.js";

export const qemuConfig = Buffer.from(`schemaVersion: 4
ordinary:
  jobs: {}
qemu:
  jobs:
    integration:
      script: .dim/ci/jobs/integration.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
`);
export const qemuScript = Buffer.from("set -o pipefail\nprintf 'candidate-executed\\n'\n");

export const qemuDescriptor: NativeQemuDescriptor = {
  schemaVersion: 1, executionKind: "qemu", admissionGeneration: "f".repeat(64), jobName: "integration",
  runnerBaseImage: `runner@sha256:${"3".repeat(64)}`, bounds: { cpu: "2", memoryBytes: "1048576",
    pids: "64", wallClockSeconds: "60", outputBytes: "1024" }, projectId: "project-a", repositoryId: "root",
  protectedRef: "refs/heads/main", expectedProtectedHead: "1".repeat(40), candidateCommit: "2".repeat(40),
  candidateTree: "3".repeat(40), policyRevision: "policy-1", requiredReviewRevision: "review-1",
  requiredJobSetRevision: "jobs-1", evidenceClass: "candidate-controlled",
  configBlob: { path: ".dim/ci/runner.yml", objectId: "4".repeat(40), sha256: digest(qemuConfig) },
  script: { path: ".dim/ci/jobs/integration.bash", objectId: "5".repeat(40), sha256: digest(qemuScript) },
  argv: ["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"],
  jobImage: `job@sha256:${"4".repeat(64)}`
};

export const qemuAssignment: NativeQemuHostAssignment = {
  claim: { claimId: "00000000-0000-4000-8000-000000000001",
    requestId: "00000000-0000-4000-8000-000000000003", hostId: "host-a", capacity: "kvm-a",
    admissionGeneration: qemuDescriptor.admissionGeneration, leaseExpiresAt: Date.now() + 60_000,
    event: { schemaVersion: 3, type: "dim.native.review-job.available",
      eventId: createHash("sha256").update("dim-native-authoritative-review-event-v3\0")
        .update(JSON.stringify({ envelopeId: "9".repeat(64), executionKind: "qemu", jobName: qemuDescriptor.jobName }))
        .digest("hex"), envelopeId: "9".repeat(64),
      projectId: qemuDescriptor.projectId, repositoryId: "root", protectedRef: qemuDescriptor.protectedRef,
      reviewId: "1".repeat(64), expectedProtectedHead: qemuDescriptor.expectedProtectedHead,
      candidateCommit: qemuDescriptor.candidateCommit, candidateTree: qemuDescriptor.candidateTree,
      policyRevision: qemuDescriptor.policyRevision, requiredReviewRevision: qemuDescriptor.requiredReviewRevision,
      qualityRevision: qemuDescriptor.requiredJobSetRevision, executionKind: "qemu",
      jobName: qemuDescriptor.jobName, evidenceClass: "candidate-controlled" } },
  attempt: { attemptId: "00000000-0000-4000-8000-000000000002",
    descriptorDigest: nativeQemuDescriptorDigest(qemuDescriptor), descriptor: qemuDescriptor }
};

export const qemuTerminalEvent = { schemaVersion: 1 as const,
  eventId: "00000000-0000-4000-8000-000000000004", occurredAt: "2026-01-01T00:00:01.000Z",
  eventType: "dim.ci.job.completed" as const, payload: { executionKind: "qemu" as const,
    evidenceClass: "candidate-controlled" as const, reviewId: "1".repeat(64),
    attemptId: qemuAssignment.attempt.attemptId, descriptor: qemuDescriptor,
    descriptorDigest: qemuAssignment.attempt.descriptorDigest, hostId: "host-a", capacity: "kvm-a",
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", result: "success" as const,
    completion: { kind: "exited" as const, exitCode: 0 }, stdout: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`,
      truncated: false }, stderr: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false } } };

export function qemuAuthority(): NativeCandidateReadAuthority {
  return {
    async resolveProtectedHead() { return "1".repeat(40); },
    async readCommit() { return { objectId: "2".repeat(40), treeObjectId: "3".repeat(40) }; },
    async readBlob(input) {
      return input.path === ".dim/ci/runner.yml"
        ? { objectId: "4".repeat(40), mode: "100644", bytes: qemuConfig }
        : { objectId: "5".repeat(40), mode: "100755", bytes: qemuScript };
    },
    async materializeTree(input) {
      await mkdir(input.destination);
      await writeFile(`${input.destination}/candidate.txt`, "verified tree\n");
      return { commitObjectId: "2".repeat(40), treeObjectId: "3".repeat(40) };
    }
  };
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
