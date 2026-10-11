import { describe, expect, it } from "vitest";
import {
  runWorkspaceLifecycle,
  runWorkspaceLifecycleStage,
  withWorkspaceLifecycleProgress
} from "../../../../core/packages/core/src/workspaceLifecycleError.js";

describe("workspace lifecycle progress", () => {
  it("reports the initial stage and each entered stage in order", async () => {
    const stages: string[] = [];

    await withWorkspaceLifecycleProgress(
      (_operation, stage) => stages.push(stage),
      () => runWorkspaceLifecycle("restart", async (setStage) => {
        setStage("workspace runtime reconciliation");
        setStage("workspace stop");
      })
    );

    expect(stages).toEqual([
      "input validation",
      "workspace runtime reconciliation",
      "workspace stop"
    ]);
  });

  it("reports a cleanup stage without inventing a second input-validation stage", async () => {
    const stages: string[] = [];

    await withWorkspaceLifecycleProgress(
      (_operation, stage) => stages.push(stage),
      () => runWorkspaceLifecycleStage("setup", "workspace setup lock release", async () => undefined)
    );

    expect(stages).toEqual(["workspace setup lock release"]);
  });

  it("keeps explicit failure attribution while reporting fallback progress", async () => {
    const stages: string[] = [];

    const lifecycle = withWorkspaceLifecycleProgress(
      (_operation, stage) => stages.push(stage),
      () => runWorkspaceLifecycle("setup", async (setStage, setErrorStage) => {
        setStage("ready-state publication");
        setErrorStage("ready-state publication");
        setStage("setup-error publication");
        throw new Error("fallback failed");
      })
    );

    await expect(lifecycle).rejects.toMatchObject({
      message: "workspace setup at ready-state publication: fallback failed",
      cause: expect.objectContaining({ message: "fallback failed" })
    });
    expect(stages).toEqual([
      "input validation",
      "ready-state publication",
      "setup-error publication"
    ]);
  });
});
