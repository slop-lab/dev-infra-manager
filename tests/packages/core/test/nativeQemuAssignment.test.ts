import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseNativeQemuHostAssignment } from "../../../../core/packages/managed/src/nativeQemuAssignment.js";
import type { NativeQemuConnection } from "../../../../core/packages/managed/src/nativeQemuConnection.js";
import { qemuExecutionDescriptorDigest } from "../../../../core/packages/native-git/src/qemu-execution-descriptor.js";

const script = Buffer.from("exit 0\n");
const descriptor = {
  schemaVersion: 1 as const, executionKind: "qemu" as const, admissionGeneration: "f".repeat(64),
  jobName: "integration", runnerBaseImage: `runner@sha256:${"1".repeat(64)}`,
  bounds: { cpu: "2", memoryBytes: "536870912", pids: "64", wallClockSeconds: "60", outputBytes: "1024" },
  projectId: "project-a", repositoryId: "root", protectedRef: "refs/heads/main",
  expectedProtectedHead: "2".repeat(40), candidateCommit: "3".repeat(40), candidateTree: "4".repeat(40),
  policyRevision: "policy-1", requiredReviewRevision: "review-1", requiredJobSetRevision: "jobs-1",
  evidenceClass: "candidate-controlled" as const,
  configBlob: { objectId: "5".repeat(40), sha256: `sha256:${"6".repeat(64)}` },
  script: { path: ".dim/ci/jobs/integration.bash", objectId: "7".repeat(40),
    sha256: `sha256:${createHash("sha256").update(script).digest("hex")}` },
  argv: ["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"] as const,
  jobImage: `job@sha256:${"8".repeat(64)}`
};
const requestId = "00000000-0000-4000-8000-000000000001";
const connection: NativeQemuConnection = { schemaVersion: 1, hostId: "host-a",
  generationId: descriptor.admissionGeneration, gitExecutable: "/usr/bin/git",
  scheduler: { transport: "loopback-http", endpoint: "http://127.0.0.1:9000", serviceId: "qemu-main",
    hostToken: Buffer.alloc(32, "a").toString("base64url") },
  nativeGit: { transport: "loopback-http", endpoint: "http://127.0.0.1:9080", serviceId: "native-main" },
  capacities: [{ capacity: "kvm-a",
    runnerBaseImage: descriptor.runnerBaseImage, jobBaseImage: descriptor.jobImage, cpus: 2,
    memoryBytes: 536870912, pids: 64, timeoutSeconds: 60, outputBytes: 1024 }] };
const envelopeId = "9".repeat(64);
const event = { schemaVersion: 3 as const, type: "dim.native.review-job.available" as const,
  eventId: createHash("sha256").update("dim-native-authoritative-review-event-v3\0")
    .update(JSON.stringify({ envelopeId, executionKind: "qemu", jobName: descriptor.jobName })).digest("hex"),
  envelopeId, projectId: descriptor.projectId, repositoryId: "root" as const,
  protectedRef: descriptor.protectedRef, reviewId: "a".repeat(64),
  expectedProtectedHead: descriptor.expectedProtectedHead, candidateCommit: descriptor.candidateCommit,
  candidateTree: descriptor.candidateTree, policyRevision: descriptor.policyRevision,
  requiredReviewRevision: descriptor.requiredReviewRevision, qualityRevision: descriptor.requiredJobSetRevision,
  executionKind: "qemu" as const, jobName: descriptor.jobName, evidenceClass: "candidate-controlled" as const };

function assignment(scriptBytesBase64: string | undefined = undefined, hostId = "host-a",
  admissionGeneration = descriptor.admissionGeneration): unknown {
  return { schemaVersion: 1, serviceId: "qemu-main", claim: { claimId: "00000000-0000-4000-8000-000000000002",
    requestId, hostId, capacity: "kvm-a", admissionGeneration,
    leaseExpiresAt: 10_000, event }, attempt: { attemptId: "00000000-0000-4000-8000-000000000003",
    descriptorDigest: qemuExecutionDescriptorDigest(descriptor), descriptor,
    ...(scriptBytesBase64 === undefined ? {} : { scriptBytesBase64 }) } };
}

describe("native QEMU host assignment boundary", () => {
  it("accepts one canonical authority and capacity-bound assignment", () => {
    expect(parseNativeQemuHostAssignment(assignment(), { connection, capacity: "kvm-a", requestId }))
      .toEqual(expect.objectContaining({ attempt: expect.objectContaining({ descriptor }) }));
  });

  it("rejects foreign hosts, generations, and script bytes that do not match the descriptor", () => {
    expect(() => parseNativeQemuHostAssignment(assignment(undefined, "host-b"),
      { connection, capacity: "kvm-a", requestId })).toThrow(/assignment/i);
    expect(() => parseNativeQemuHostAssignment(assignment(Buffer.from("exit 1\n").toString("base64")),
      { connection, capacity: "kvm-a", requestId })).toThrow(/assignment/i);
    expect(() => parseNativeQemuHostAssignment(assignment(undefined, "host-a", "e".repeat(64)),
      { connection, capacity: "kvm-a", requestId })).toThrow(/assignment/i);
  });

  it("rejects unknown event fields before execution", () => {
    const value = assignment() as { claim: { event: Record<string, unknown> } };
    value.claim.event.extra = true;
    expect(() => parseNativeQemuHostAssignment(value, { connection, capacity: "kvm-a", requestId }))
      .toThrow(/event|assignment/i);
  });
});
