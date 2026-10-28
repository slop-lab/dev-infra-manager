import type { createAuthoritativeNativeReviewEnvelope } from "../../../../packages/control-plane/plugins/git-ci/src/plan-schema.js";

const primary = { commit: "2".repeat(40), tree: "3".repeat(40) };
const job = { executionKind: "ordinary-sysbox", jobName: "source", evidenceClass: "candidate-controlled" } as const;

export const projectionDigestInput = {
  identity: {
    schemaVersion: 2, serviceId: "native-main", projectId: "project-a", repositoryId: "root",
    inputs: { root: primary }, protectedRef: "refs/heads/main", proposalRef: "refs/heads/feature",
    expectedProtectedHead: "1".repeat(40), candidateCommit: primary.commit, candidateTree: primary.tree,
    policyRevision: "4".repeat(64), requiredReviewRevision: "5".repeat(64), requiredReviewerIds: ["owner"],
    changes: [], patch: "synthetic\n", patchBytes: Buffer.from("synthetic\n").toString("base64")
  },
  policyDigest: "6".repeat(64), qualityRevision: "7".repeat(64), requiredJobs: [job],
  planning: { status: "valid", configBlob: null, jobs: [{ ...job,
    script: { objectId: "8".repeat(40), sha256: `sha256:${"9".repeat(64)}`, path: "ci/source.sh" },
    argv: ["/bin/sh"], inputs: { root: primary }
  }] },
  createdAt: "2026-01-01T00:00:00.000Z"
} satisfies Parameters<typeof createAuthoritativeNativeReviewEnvelope>[0];
