import { describe, expect, it } from "vitest";
import {
  ordinaryCiPoolPolicyDigest,
  type OrdinaryCiPoolAdmissionInput
} from "../../../../core/packages/core/src/ordinaryCiPoolAdmission.js";

const IMAGE = `registry.example/dim/common@sha256:${"a".repeat(64)}`;

describe("ordinary CI reviewed admission identity", () => {
  it("rotates when protected provenance or reviewed labels change", () => {
    // Given
    const original = admission();

    // When
    const commitChanged = ordinaryCiPoolPolicyDigest("pool-main", { ...original, sourceCommit: "2".repeat(40) });
    const labelsChanged = ordinaryCiPoolPolicyDigest("pool-main", { ...original, runnerLabels: ["dim-other"] });

    // Then
    expect(commitChanged).not.toBe(ordinaryCiPoolPolicyDigest("pool-main", original));
    expect(labelsChanged).not.toBe(ordinaryCiPoolPolicyDigest("pool-main", original));
  });

  it("binds the service identity and common digest image", () => {
    // Given
    const original = admission();

    // When
    const otherService = ordinaryCiPoolPolicyDigest("pool-secondary", original);
    const otherImage = ordinaryCiPoolPolicyDigest("pool-main", {
      ...original,
      jobImage: `registry.example/dim/common@sha256:${"b".repeat(64)}`
    });

    // Then
    expect(otherService).not.toBe(ordinaryCiPoolPolicyDigest("pool-main", original));
    expect(otherImage).not.toBe(ordinaryCiPoolPolicyDigest("pool-main", original));
  });
});

function admission(): OrdinaryCiPoolAdmissionInput {
  return {
    projectId: "project-a",
    projectName: "alpha",
    organization: "dim-alpha",
    organizationId: 41,
    sourceRef: "refs/heads/main",
    sourceCommit: "1".repeat(40),
    configDigest: "c".repeat(64),
    jobImage: IMAGE,
    runnerLabels: ["dim-ordinary"]
  };
}
