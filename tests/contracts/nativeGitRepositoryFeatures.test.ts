import { describe, expect, it } from "vitest";
import { repositoryFeatureOperations } from "../../packages/service-clients/native-git/src/repository-features.js";

describe("native Git pull-request operation contracts", () => {
  it("accepts ordinary and legacy candidate refs while keeping targets on ordinary branches", () => {
    // Given
    const operation = repositoryFeatureOperations.find((candidate) => candidate.name === "pull-requests.create");
    if (operation === undefined) throw new TestSetupError();
    const scope = { projectId: "project", repositoryId: "repository", title: "Candidate" };
    const workspaceId = Buffer.alloc(32, 5).toString("base64url");

    // When / Then
    for (const sourceRef of ["refs/heads/feature", "refs/tags/v1", `refs/heads/proposals/${workspaceId}/change`]) {
      expect(operation.parseInput({ ...scope, sourceRef, targetRef: "refs/heads/main" })).toMatchObject({ sourceRef });
    }
    expect(() => operation.parseInput({ ...scope, sourceRef: "refs/remotes/origin/main" })).toThrow();
    expect(() => operation.parseInput({ ...scope, sourceRef: "refs/heads/feature", targetRef: "refs/tags/v1" })).toThrow();
  });
});

class TestSetupError extends Error { readonly name = "TestSetupError"; }
