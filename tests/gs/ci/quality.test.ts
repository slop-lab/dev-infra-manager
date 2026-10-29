import { describe, expect, it } from "vitest";
import type { CiExecutionEvidence } from "../../../packages/gs/ci-contracts/src/index.js";
import * as ci from "../../../packages/gs/ci/src/index.js";

const request = {
  provider: "portable",
  providerRevision: "a".repeat(64),
  eventId: "b".repeat(64),
  reviewId: "c".repeat(64),
  envelopeId: "d".repeat(64),
  candidateCommit: "e".repeat(40),
  candidateTree: "f".repeat(40),
  policyDigest: "1".repeat(64),
} as const;

describe("GS CI required execution evidence", () => {
  it("requires a selected git-ci authorization provider for git-ci policy", () => {
    expect(ci.gitCiPolicyOwner.enforcement).toBe("authorization");
    expect(Reflect.get(ci, "createGitCiRefUpdatePolicy")).toBeDefined();
  });

  it("accepts exact successful evidence from a portable provider", async () => {
    const check = Reflect.get(ci, "checkRequiredExecutionEvidence");
    const evidence: CiExecutionEvidence = {
      schemaVersion: 1,
      ...request,
      outcome: "succeeded",
      evidenceId: "portable:run-1",
      digest: "2".repeat(64),
    };

    expect(check).toBeDefined();
    await expect(check({
      request,
      provider: { name: "portable", revision: request.providerRevision, read: async () => evidence },
    })).resolves.toEqual({ kind: "git-ci", id: "portable:run-1", digest: evidence.digest });
  });

  it("fails closed for missing or stale provider evidence", async () => {
    const check = Reflect.get(ci, "checkRequiredExecutionEvidence");
    expect(check).toBeDefined();

    await expect(check({
      request,
      provider: { name: "portable", revision: request.providerRevision, read: async () => undefined },
    })).rejects.toThrow(/missing/i);
    await expect(check({
      request,
      provider: { name: "portable", revision: request.providerRevision, read: async () => ({
        schemaVersion: 1,
        ...request,
        providerRevision: "3".repeat(64),
        outcome: "succeeded",
        evidenceId: "portable:stale",
        digest: "4".repeat(64),
      }) },
    })).rejects.toThrow(/stale/i);
  });
});
