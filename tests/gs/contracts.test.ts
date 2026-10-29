import { describe, expect, it } from "vitest";
import { executionInputsSchema, isCandidateArgv, isCandidatePath,
  reviewCiStatusSchema } from "../../packages/gs/ci-contracts/src/index.js";
import * as ciContracts from "../../packages/gs/ci-contracts/src/index.js";
import {
  parseRepositoryPolicy,
  repositoryBranches,
  repositoryPolicyRevision,
  repositorySnapshotsSchema,
  type RepositorySelector
} from "../../packages/gs/repository-contracts/src/index.js";

describe("GS-owned portable contracts", () => {
  it("hosts branch metadata without selecting a review feature", () => {
    // Given
    const declaration = { protectedRef: "refs/heads/main", extensions: {} };
    const policy = parseRepositoryPolicy({ schemaVersion: 1, ...declaration,
      policyRevision: repositoryPolicyRevision(declaration) });
    // When
    const branches = repositoryBranches(policy);
    // Then
    expect(branches).toEqual({ "refs/heads/main": {} });
  });

  it("uses namespace selectors and the preserved repository snapshot bytes", () => {
    const selector: RepositorySelector = { namespaceId: "example", repositoryId: "application" };
    const snapshots = { application: { commit: "a".repeat(40), tree: "b".repeat(40) } };

    expect(selector).toEqual({ namespaceId: "example", repositoryId: "application" });
    expect(repositorySnapshotsSchema.parse(snapshots)).toEqual(snapshots);
    expect(executionInputsSchema.parse(snapshots)).toEqual(snapshots);
  });

  it("exports neutral workflow and CI evidence schemas without execution transport", () => {
    expect(isCandidatePath(".dim/ci.yml")).toBe(true);
    expect(isCandidateArgv(["/bin/sh", "script.sh"])).toBe(true);
    expect(Reflect.get(ciContracts, "workflowJobSchema")).toBeDefined();
    expect(Reflect.get(ciContracts, "reviewCheckAvailableEventSchema")).toBeDefined();
    expect(Reflect.get(ciContracts, "candidateExecutionDescriptorSchema")).toBeUndefined();
    expect(Reflect.get(ciContracts, "executionProfileFields")).toBeUndefined();
    expect(Reflect.get(ciContracts, "reviewJobAvailableEventSchema")).toBeUndefined();
    expect(ciContracts.workflowJobSchema.parse({
      name: "check",
      provider: "portable",
      script: "ci/check.sh",
      argv: ["/bin/sh", "ci/check.sh"],
    })).toMatchObject({ provider: "portable" });
    expect(() => ciContracts.workflowJobSchema.parse({
      name: "check",
      kind: "ordinary-sysbox",
      script: "ci/check.sh",
      argv: ["/bin/sh", "ci/check.sh"],
    })).toThrow();
    expect(reviewCiStatusSchema).toBeDefined();
  });
});
