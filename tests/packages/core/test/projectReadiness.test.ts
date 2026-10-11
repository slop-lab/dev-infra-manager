import { describe, expect, it } from "vitest";
import { assertReadyProject } from "../../../../core/packages/core/src/project-registry/helpers.js";
import type { ProjectRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";

describe("Project readiness", () => {
  it("rejects a ready typed Project without a trusted Gitea organization ID", () => {
    // Given
    const project: ProjectRecord = {
      schemaVersion: 4,
      id: "project-id",
      name: "example",
      gitNamespace: "dim-example",
      giteaOrganizationId: null,
      phase: "ready",
      repositories: [],
      createdAt: "now",
      updatedAt: "now"
    };

    // When
    const check = () => assertReadyProject(project);

    // Then
    expect(check).toThrow(/trusted Gitea organization ID/);
  });
});
