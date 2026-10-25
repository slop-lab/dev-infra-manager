import { describe, expect, it } from "vitest";
import { nativeRepositoryPolicyRevision } from "@slop-lab/dim-contracts-git";
import { workspaceProtectedRefs } from "../../../../packages/control-plane/plugins/git-repositories/src/candidate-ref-policy.js";

describe("native candidate ref protection", () => {
  it("combines managed policy refs with permanently protected conventional refs", () => {
    // Given
    const branches = {
      "refs/heads/trunk": { review: true },
      "refs/heads/release": { review: false }
    } as const;
    const input = {
      protectedRef: "refs/heads/trunk",
      defaultRef: "refs/heads/trunk",
      branches,
      extensions: {}
    } as const;
    const policy = { schemaVersion: 1 as const, ...input, policyRevision: nativeRepositoryPolicyRevision(input) };

    // When
    const refs = workspaceProtectedRefs(policy);

    // Then
    expect(refs).toEqual([
      "refs/heads/development",
      "refs/heads/main",
      "refs/heads/release",
      "refs/heads/trunk"
    ]);
  });
});
