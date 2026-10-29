import { describe, expect, it } from "vitest";
import {
  candidateExecutionDescriptorSchema,
  executionInputsSchema,
  isCandidateArgv,
  isCandidatePath,
  reviewCiStatusSchema
} from "../../packages/gs/ci-contracts/src/index.js";
import {
  repositorySnapshotsSchema,
  type RepositorySelector
} from "../../packages/gs/repository-contracts/src/index.js";

describe("GS-owned portable contracts", () => {
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
    expect(candidateExecutionDescriptorSchema).toBeDefined();
    expect(reviewCiStatusSchema).toBeDefined();
  });
});
