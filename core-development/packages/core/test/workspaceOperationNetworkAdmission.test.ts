import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startHost } from "../../../../core/packages/core/src/hostLifecycle.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { LifecycleOptions } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import {
  createWorkspace,
  restartWorkspace,
  setupWorkspace,
  startWorkspace,
  updateWorkspace
} from "../../../../core/packages/core/src/workspaceLifecycle.js";
import { hostLifecycleOptions, hostRecord, workspaceRecord } from "./hostLifecycleFixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persisted workspace network admission", () => {
  it("rejects obsolete external bridge before create mutation", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-workspace-network-create-"));
    roots.push(root);
    const state = new LifecycleState(root);
    const record = { ...workspaceRecord("legacy", "stopped"), networkName: "bridge" };
    await state.claimWorkspace(record);
    const calls: string[][] = [];

    // When
    const result = createWorkspace(recordingRunner(calls), externalOptions(root), {
      project: record.projectName,
      name: record.name,
      profiles: record.profiles,
      runtimeBackend: record.runtimeBackend
    });

    // Then
    await expect(result).rejects.toThrow(/obsolete external-Git bridge 'bridge'/);
    await expect(state.readWorkspace(record.name)).resolves.toEqual(record);
    expect(calls).toEqual([]);
  });

  it.each([
    ["start", startWorkspace],
    ["restart", restartWorkspace],
    ["setup", setupWorkspace],
    ["update", updateWorkspace]
  ] as const)("rejects obsolete external bridge before %s mutation", async (_operation, execute) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-workspace-network-operation-"));
    roots.push(root);
    const state = new LifecycleState(root);
    const record = { ...workspaceRecord("legacy", "stopped"), networkName: "bridge" };
    await state.claimWorkspace(record);
    const calls: string[][] = [];
    const runner = recordingRunner(calls);

    // When
    const result = execute(runner, externalOptions(root), record.name);

    // Then
    await expect(result).rejects.toThrow(/obsolete external-Git bridge 'bridge'/);
    await expect(state.readWorkspace(record.name)).resolves.toEqual(record);
    expect(calls).toEqual([]);
  });

  it("rejects obsolete external bridge before host recovery mutation", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-workspace-network-recovery-"));
    roots.push(root);
    const state = new LifecycleState(root);
    const record = { ...workspaceRecord("legacy", "stopped"), networkName: "bridge" };
    const lifecycle = hostRecord("stopped", { resumeWorkspaces: [record.name], restartCiRunners: [] });
    await state.claimWorkspace(record);
    await state.writeHostLifecycle(lifecycle);
    const calls: string[][] = [];

    // When
    const result = startHost(recordingRunner(calls), externalOptions(root));

    // Then
    await expect(result).rejects.toThrow(/obsolete external-Git bridge 'bridge'/);
    await expect(state.readHostLifecycle()).resolves.toEqual(lifecycle);
    await expect(state.readWorkspace(record.name)).resolves.toEqual(record);
    expect(calls).toEqual([]);
  });
});

function externalOptions(root: string): LifecycleOptions {
  return {
    ...hostLifecycleOptions(root),
    giteaConnection: { kind: "external", file: "/run/dim/gitea.json" }
  };
}

function recordingRunner(calls: string[][]): StreamingCommandRunner {
  return {
    async run(command, args) {
      calls.push([command, ...args]);
      return { command, args, stdout: "", stderr: "unexpected Docker mutation", exitCode: 1 };
    },
    async runStreaming(command, args) {
      calls.push([command, ...args]);
      return 1;
    }
  };
}
