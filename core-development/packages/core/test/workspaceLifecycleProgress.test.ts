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
});
