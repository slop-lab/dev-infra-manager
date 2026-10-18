import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LifecycleState } from "../../../../core/packages/managed/src/lifecycleState.js";
import type { WorkspaceRecord } from "../../../../core/packages/managed/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { runWorkspace } from "../../../../core/packages/managed/src/workspaceLifecycle.js";
import { lifecycleFileExists, runProjectSetup, runProjectTeardown
} from "../../../../core/packages/managed/src/workspaceProjectCommands.js";
import { workspaceContainerInspect } from "./workspaceOwnershipFixture.js";
import { hostLifecycleOptions, workspaceRecord } from "./hostLifecycleFixture.js";

const exceptionalExitCodes = [2, 125, 127] as const;

class ProbeRunner implements StreamingCommandRunner {
  readonly streamingCalls: string[][] = [];

  constructor(
    private readonly record: WorkspaceRecord,
    private readonly stateRoot: string,
    private readonly probePath: string,
    private readonly probeExitCode: number
  ) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    if (args.includes("-f")) {
      const exitCode = args.at(-1) === this.probePath ? this.probeExitCode : 1;
      return { command, args, stdout: "", stderr: exitCode > 1 ? `probe diagnostic ${exitCode}` : "", exitCode };
    }
    if (args[0] === "container" && args[1] === "inspect") {
      return { command, args, stdout: `${workspaceContainerInspect(this.record, {
        rootSnapshotPath: join(this.stateRoot, "assets", "native-project-roots",
          this.record.projectId, this.record.rootCommit)
      })}\n`, stderr: "", exitCode: 0 };
    }
    return { command, args, stdout: "", stderr: "", exitCode: 0 };
  }

  async runStreaming(command: string, args: string[]): Promise<number> {
    this.streamingCalls.push([command, ...args]);
    return 0;
  }
}

describe("native lifecycle file probes", () => {
  let root = "";
  let record: WorkspaceRecord;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-lifecycle-probe-"));
    record = workspaceRecord("work-1", "ready");
    await mkdir(join(root, "assets", "native-project-roots", record.projectId, record.rootCommit), {
      recursive: true
    });
    await new LifecycleState(root).claimWorkspace(record);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([[0, true], [1, false]] as const)("treats probe exit %i as file presence %s",
    async (exitCode, expected) => {
      const runner = new ProbeRunner(record, root, ".dim/setup.sh", exitCode);
      await expect(lifecycleFileExists(runner, record, ".dim/setup.sh")).resolves.toBe(expected);
    });

  it.each(exceptionalExitCodes)("rejects setup probe exit %i before dispatch", async (exitCode) => {
    const runner = new ProbeRunner(record, root, ".dim/setup.sh", exitCode);
    await expect(runProjectSetup(runner, record, false, false)).rejects.toThrow(`probe diagnostic ${exitCode}`);
    expect(runner.streamingCalls).toEqual([]);
  });

  it.each(exceptionalExitCodes)("rejects teardown probe exit %i before dispatch", async (exitCode) => {
    const runner = new ProbeRunner(record, root, ".dim/teardown.sh", exitCode);
    await expect(runProjectTeardown(runner, root, record, false)).rejects.toThrow(`probe diagnostic ${exitCode}`);
    expect(runner.streamingCalls).toEqual([]);
  });

  it.each(exceptionalExitCodes)("rejects Compose probe exit %i before dispatch", async (exitCode) => {
    const runner = new ProbeRunner(record, root, ".dim/docker-compose.yml", exitCode);
    await expect(runProjectSetup(runner, record, false, false)).rejects.toThrow(`probe diagnostic ${exitCode}`);
    expect(runner.streamingCalls).toEqual([]);
  });

  it.each(exceptionalExitCodes)("rejects entrypoint probe exit %i before command dispatch", async (exitCode) => {
    const runner = new ProbeRunner(record, root, ".dim/entrypoint.sh", exitCode);
    await expect(runWorkspace(runner, hostLifecycleOptions(root), {
      name: record.name,
      command: ["codex"],
      interactive: false
    })).rejects.toThrow(`probe diagnostic ${exitCode}`);
    expect(runner.streamingCalls).toEqual([]);
  });

  it.each([
    ["setup", ".dim/setup.sh", (runner: ProbeRunner) => runProjectSetup(runner, record, false, false)],
    ["teardown", ".dim/teardown.sh", (runner: ProbeRunner) => runProjectTeardown(runner, root, record, false)]
  ] as const)("dispatches project %s as the unprivileged workspace user", async (_name, path, invoke) => {
    const runner = new ProbeRunner(record, root, path, 0);
    await invoke(runner);
    expect(runner.streamingCalls[0]?.slice(0, 4)).toEqual(["docker", "exec", "--user", "dim"]);
  });
});
