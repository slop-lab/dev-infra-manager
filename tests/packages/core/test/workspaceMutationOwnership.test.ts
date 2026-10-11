import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import {
  showWorkspace,
  stopWorkspace,
  updateWorkspaceResources
} from "../../../../core/packages/core/src/workspaceLifecycle.js";
import { workspaceContainerLabels } from "../../../../core/packages/core/src/workspaceResourceOwnership.js";
import { options, projectFixture, workspaceFixture } from "./workspaceUpdateLockFixture.js";
import { workspaceContainerInspect } from "./workspaceOwnershipFixture.js";

class MutationRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];

  constructor(private readonly inspectOutput: string) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if (args[0] === "container" && args[1] === "inspect") {
      return { command, args, stdout: `${this.inspectOutput}\n`, stderr: "", exitCode: 0 };
    }
    return { command, args, stdout: "", stderr: "", exitCode: 0 };
  }

  async runStreaming(): Promise<number> {
    throw new Error("workspace mutations must use inspected-ID command results");
  }
}

describe("workspace mutation ownership", () => {
  let root = "";
  let record: WorkspaceRecord;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-workspace-mutation-"));
    record = workspaceFixture(root, projectFixture());
    await new LifecycleState(root).claimWorkspace(record);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("updates inspected ID A without updating foreign same-name replacement B", async () => {
    // Given
    const runner = new MutationRunner(workspaceContainerInspect(record, { id: "owned-id" }));

    // When
    await updateWorkspaceResources(runner, options(root), record.name, { memory: "5g" });

    // Then
    expectCompleteInspection(runner);
    expect(runner.calls).toContainEqual([
      "docker", "update", "--cpus", "2", "--memory", "5g", "--memory-swap", "5g",
      "--pids-limit", "2048", "owned-id"
    ]);
    expect(runner.calls.some((call) => call[1] === "update" && call.at(-1) === record.containerName)).toBe(false);
  });

  it("stops inspected ID A without stopping foreign same-name replacement B", async () => {
    // Given
    const runner = new MutationRunner(workspaceContainerInspect(record, { id: "owned-id" }));

    // When
    await stopWorkspace(runner, options(root), record.name);

    // Then
    expectCompleteInspection(runner);
    expect(runner.calls).toContainEqual(["docker", "stop", "owned-id"]);
    expect(runner.calls).not.toContainEqual(["docker", "stop", record.containerName]);
  });

  it("rejects a same-name foreign container during runtime-state reuse", async () => {
    // Given
    const labels = workspaceContainerLabels(record).map((label) =>
      label.startsWith("dim.project-id=") ? "foreign-project-id" : labelValue(label));
    const runner = new MutationRunner(["foreign-id", "true", ...labels, "7"].join("|"));

    // When / Then
    await expect(showWorkspace(runner, options(root), record.name)).rejects.toThrow(/conflicts with DIM ownership/);
    await expect(new LifecycleState(root).readWorkspace(record.name)).resolves.toEqual(record);
  });
});

function expectCompleteInspection(runner: MutationRunner): void {
  const inspect = runner.calls.find((call) => call[1] === "container" && call[2] === "inspect");
  for (const key of [
    "dim.managed", "dim.owner", "dim.workspace", "dim.project", "dim.project-id",
    "dim.repo", "dim.backend", "dim.resource", "dim.digest"
  ]) expect(inspect?.at(-1)).toContain(`"${key}"`);
}

function labelValue(label: string): string {
  return label.slice(label.indexOf("=") + 1);
}
