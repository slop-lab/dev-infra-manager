import type { CandidateOrdinaryExecutionDescriptor } from "../../../../core/packages/native-git/src/candidate-execution-schema.js";

const runnerBaseImage = `registry.example/runner@sha256:${"3".repeat(64)}`;
const jobBaseImage = `registry.example/source@sha256:${"8".repeat(64)}`;
const bounds = {
  cpu: "2",
  memoryBytes: "2147483648",
  pids: "512",
  wallClockSeconds: "900",
  outputBytes: "10485760"
} as const;

export function admission(projectId: string, repositoryId: string, revision: string) {
  return {
    schemaVersion: 1,
    projectId,
    repositoryId,
    protectedRef: "refs/heads/main",
    policyRevision: `policy-${revision}`,
    requiredReviewRevision: `review-${revision}`,
    requiredJobSetRevision: `jobs-${revision}`,
    requiredJobs: ["source"]
  } as const;
}

export function descriptor(projectId: string, repositoryId: string, generation: string): CandidateOrdinaryExecutionDescriptor {
  return {
    projectId,
    repositoryId,
    protectedRef: "refs/heads/main",
    expectedProtectedHead: "1".repeat(40),
    candidateCommit: "2".repeat(40),
    candidateTree: "3".repeat(40),
    policyRevision: "policy-1",
    requiredReviewRevision: "review-1",
    requiredJobSetRevision: "jobs-1",
    admissionGeneration: generation,
    jobName: "source",
    runnerBaseImage,
    bounds,
    evidenceClass: "candidate-controlled",
    configBlob: { path: ".dim/ci/runner.yml", objectId: "4".repeat(40), sha256: `sha256:${"5".repeat(64)}` },
    script: { objectId: "6".repeat(40), sha256: `sha256:${"7".repeat(64)}`, path: ".dim/ci/jobs/source.bash" },
    argv: ["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"],
    jobImage: jobBaseImage
  };
}

