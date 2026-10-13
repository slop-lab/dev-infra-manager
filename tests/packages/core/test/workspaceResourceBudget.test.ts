import { describe, expect, it } from "vitest";
import {
  allocateWorkspaceResourceBudget,
  RECOMMENDED_WORKSPACE_MINIMUMS
} from "../../../../core/packages/core/src/workspaceResourceBudget.js";

describe("workspace resource budgets", () => {
  it("partitions a recommended budget without exceeding any recorded limit", () => {
    // Given
    const recorded = { cpuCount: "2.5", memory: "4g", pidsLimit: "1025" };

    // When
    const allocated = allocateWorkspaceResourceBudget("recommended", recorded);

    // Then
    expect(allocated).toEqual({
      outer: { cpuCount: "0.625", memory: "1073741824", pidsLimit: "256" },
      agent: { cpuCount: "1.875", memory: "3221225472", pidsLimit: "769" }
    });
  });

  it("accepts the exact recommended minimum budget", () => {
    // Given
    const recorded = { ...RECOMMENDED_WORKSPACE_MINIMUMS };

    // When
    const allocated = allocateWorkspaceResourceBudget("recommended", recorded);

    // Then
    expect(allocated).toEqual({
      outer: { cpuCount: "0.25", memory: "268435456", pidsLimit: "64" },
      agent: { cpuCount: "0.75", memory: "805306368", pidsLimit: "192" }
    });
  });

  it("rejects a recommended budget below the two-container minimum", () => {
    // Given
    const recorded = { cpuCount: "0.999", memory: "1023m", pidsLimit: "255" };

    // When / Then
    expect(() => allocateWorkspaceResourceBudget("recommended", recorded)).toThrow(
      /recommended workspace resources require at least 1 CPU, 1 GiB memory, and 256 PIDs/
    );
  });

  it("leaves the actual custom workspace budget on the outer container", () => {
    // Given
    const recorded = { cpuCount: "0.5", memory: "128m", pidsLimit: "32" };

    // When
    const allocated = allocateWorkspaceResourceBudget("custom", recorded);

    // Then
    expect(allocated).toEqual({ outer: recorded });
  });
});
