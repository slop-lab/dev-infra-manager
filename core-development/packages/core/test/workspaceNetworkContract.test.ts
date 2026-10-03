import { describe, expect, it } from "vitest";
import { assertWorkspaceNetworkContract } from "../../../../core/packages/core/src/workspaceValidation.js";
import { workspaceRecord } from "./hostLifecycleFixture.js";

describe("workspace network contract", () => {
  it("rejects a schema-8 workspace retained on the obsolete external-Git bridge", () => {
    const record = { ...workspaceRecord("work-1", "ready"), networkName: "dim-gitea" };

    expect(() => assertWorkspaceNetworkContract(record, { kind: "external", file: "/run/dim/gitea.json" }))
      .toThrow(/obsolete external-Git bridge 'dim-gitea'; discard and recreate it/);
  });

  it("accepts a schema-8 external-Git workspace on the shared control network", () => {
    const record = { ...workspaceRecord("work-1", "ready"), networkName: "dim-control" };

    expect(() => assertWorkspaceNetworkContract(record, { kind: "external", file: "/run/dim/gitea.json" }))
      .not.toThrow();
  });
});
