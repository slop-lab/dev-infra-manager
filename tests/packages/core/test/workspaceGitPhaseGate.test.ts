import { describe, expect, it } from "vitest";
import { workspaceGitOperationAllowed } from "../../../../core/packages/managed/src/nativeWorkspaceGitBroker.js";
import type { WorkspacePhase } from "../../../../core/packages/managed/src/lifecycleTypes.js";

describe("workspace Git phase fence", () => {
  const cases: readonly [WorkspacePhase, boolean, boolean][] = [
    ["creating", false, false],
    ["setting-up", true, false],
    ["ready", true, true],
    ["stopped", false, false],
    ["setup-error", false, false],
    ["error", false, false],
    ["discarding", false, false]
  ];

  it.each(cases)("allows phase %s with read=%s and write=%s", (phase, read, write) => {
    // Given / When / Then
    expect(workspaceGitOperationAllowed(phase, "read")).toBe(read);
    expect(workspaceGitOperationAllowed(phase, "write")).toBe(write);
  });
});
