import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/managed/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/managed/src/lifecycleState.js";
import type { WorkspaceRecord } from "../../../../core/packages/managed/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { execWorkspace, runWorkspace } from "../../../../core/packages/managed/src/workspaceLifecycle.js";
import { workspaceAgentContainerLabels, workspaceAgentIdentity } from "../../../../core/packages/managed/src/workspaceAgentRuntime.js";
import { workspaceContainerInspect } from "./workspaceOwnershipFixture.js";
import { nativeWorkspaceFixture } from "./nativeLifecycleFixture.js";

const agentId = "a".repeat(64);
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("workspace command dispatch", () => {
  it.each([
    { invoke: "run" as const, environment: "recommended" as const, expectedContainer: agentId },
    { invoke: "exec" as const, environment: "recommended" as const, expectedContainer: agentId },
    { invoke: "exec" as const, environment: "custom" as const, expectedContainer: "outer-id" }
  ])("routes $invoke for $environment to $expectedContainer", async ({ invoke, environment, expectedContainer }) => {
    const root = await mkdtemp(join(tmpdir(), "dim-command-dispatch-"));
    roots.push(root);
    const record = fixture(environment);
    await mkdir(join(root, "assets", "native-project-roots", record.projectId, record.rootCommit), { recursive: true });
    await new LifecycleState(root).claimWorkspace(record);
    const runner = new DispatchRunner(record, root);
    const options = lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root });

    const operation = invoke === "run"
      ? runWorkspace(runner, options, { name: record.name, command: ["exec", "git", "status"], interactive: false })
      : execWorkspace(runner, options, { name: record.name, command: ["git", "status"], interactive: false });
    await expect(operation).resolves.toBe(0);
    expect(runner.streaming.at(-1)).toEqual(expect.arrayContaining([expectedContainer, "git", "status"]));
  });
});

class DispatchRunner implements StreamingCommandRunner {
  readonly streaming: string[][] = [];
  constructor(private readonly record: WorkspaceRecord, private readonly root: string) {}
  async run(command: string, args: string[]): Promise<CommandResult> {
    if (args[0] === "container" && args[1] === "inspect" && args[2] === this.record.containerName) {
    const snapshot = join(this.root, "assets", "native-project-roots", this.record.projectId, this.record.rootCommit);
      return output(command, args, workspaceContainerInspect(this.record, { id: "outer-id", rootSnapshotPath: snapshot }));
    }
    if (args[0] === "container" && args[1] === "inspect") return output(command, args, agentInspect(this.record));
    return output(command, args);
  }
  async runStreaming(command: string, args: string[]): Promise<number> { this.streaming.push([command, ...args]); return 0; }
}

function output(command: string, args: string[], stdout = ""): CommandResult {
  return { command, args, stdout, stderr: "", exitCode: 0 };
}

function agentInspect(record: WorkspaceRecord): string {
  const identity = workspaceAgentIdentity(record);
  const labels = JSON.stringify(Object.fromEntries(workspaceAgentContainerLabels(record).map((value) => value.split("=", 2))));
  return [agentId, "true", `sha256:${"f".repeat(64)}`, "sysbox-runc", "false", labels, JSON.stringify([
    { Type: "volume", Name: identity.homeVolumeName, Source: "/docker/home", Destination: "/home/dim", RW: true },
    { Type: "volume", Name: identity.checkoutVolumeName, Source: "/docker/checkout", Destination: "/workspace", RW: true },
    { Type: "volume", Name: identity.dockerVolumeName, Source: "/docker/data", Destination: "/var/lib/docker", RW: true }
  ])].join("|");
}

function fixture(environment: "recommended" | "custom"): WorkspaceRecord {
  return nativeWorkspaceFixture({
    rootCommit: "b".repeat(40), environment, gitUserName: "Agent",
    gitUserEmail: "agent@example.invalid", createdAt: "now", updatedAt: "now"
  });
}
