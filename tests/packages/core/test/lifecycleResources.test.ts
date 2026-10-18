import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifecycleState } from "../../../../core/packages/managed/src/lifecycleState.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { updateWorkspaceResources } from "../../../../core/packages/managed/src/workspaceLifecycle.js";
import { workspaceAgentContainerLabels, workspaceAgentIdentity
} from "../../../../core/packages/managed/src/workspaceAgentRuntime.js";
import { hostLifecycleOptions, workspaceRecord } from "./hostLifecycleFixture.js";
import { workspaceContainerInspect } from "./workspaceOwnershipFixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native workspace resources", () => {
  it("updates owned outer and agent containers and persists effective resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-lifecycle-resources-"));
    roots.push(root);
    const state = new LifecycleState(root);
    const record = { ...workspaceRecord("work-1", "ready"), environment: "recommended" as const };
    await state.claimWorkspace(record);
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command: string, args: string[]): Promise<CommandResult> {
        calls.push([command, ...args]);
        if ((args[0] === "container" && args[1] === "inspect") || args[0] === "inspect") {
          if (args.includes("{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.PidsLimit}}")) {
            const agent = args[2] === "a".repeat(64);
            return { command, args, stdout: agent
              ? "3000000000|2415919104|2415919104|768\n"
              : "1000000000|805306368|805306368|256\n", stderr: "", exitCode: 0 };
          }
          if (args[2] === "dim-agent-work-1") {
            const identity = workspaceAgentIdentity(record);
            const labels = JSON.stringify(Object.fromEntries(
              workspaceAgentContainerLabels(record).map((label) => label.split("=", 2))
            ));
            const mounts = JSON.stringify([
              { Type: "volume", Name: identity.homeVolumeName,
                Source: `/docker/volumes/${identity.homeVolumeName}/_data`, Destination: "/home/dim", RW: true },
              { Type: "volume", Name: identity.checkoutVolumeName,
                Source: `/docker/volumes/${identity.checkoutVolumeName}/_data`, Destination: "/workspace", RW: true },
              { Type: "volume", Name: identity.dockerVolumeName,
                Source: `/docker/volumes/${identity.dockerVolumeName}/_data`, Destination: "/var/lib/docker", RW: true }
            ]);
            return { command, args,
              stdout: `${"a".repeat(64)}|true|sha256:${"f".repeat(64)}|sysbox-runc|false|${labels}|${mounts}\n`,
              stderr: "", exitCode: 0 };
          }
          return { command, args, stdout: `${workspaceContainerInspect(record, {
            rootSnapshotPath: join(root, "assets", "native-project-roots", record.projectId, record.rootCommit)
          })}\n`, stderr: "", exitCode: 0 };
        }
        return { command, args, stdout: "dim-ws-work-1\n", stderr: "", exitCode: 0 };
      },
      async runStreaming(): Promise<number> { return 0; }
    };

    const updated = await updateWorkspaceResources(runner, hostLifecycleOptions(root), record.name, {
      memory: "3g", pidsLimit: "1024"
    });

    expect(updated).toMatchObject({ cpuCount: "4", memory: "3g", pidsLimit: "1024" });
    await expect(state.readWorkspace(record.name)).resolves.toMatchObject({
      cpuCount: "4", memory: "3g", pidsLimit: "1024"
    });
    expect(calls.some((call) => call[0] === "docker" && call[1] === "update")).toBe(true);
  });
});
