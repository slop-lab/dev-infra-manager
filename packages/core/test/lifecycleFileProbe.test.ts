import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult } from "../../../../core/packages/core/src/types.js";
import { runWorkspace } from "../../../../core/packages/core/src/workspaceLifecycle.js";
import {
  lifecycleFileExists,
  runProjectSetup,
  runProjectTeardown
} from "../../../../core/packages/core/src/workspaceProjectCommands.js";
import { COMMIT, LifecycleRunner, repositorySnapshot } from "./workspaceLifecycleSnapshotFixture.js";

const EXCEPTIONAL_EXIT_CODES = [2, 125, 127] as const;

class LifecycleProbeRunner extends LifecycleRunner {
  constructor(
    private readonly probePath: string,
    private readonly probeExitCode: number
  ) {
    super(new Set());
  }

  override async run(command: string, args: string[]): Promise<CommandResult> {
    if (!args.includes("-f")) return super.run(command, args);
    this.runCalls.push([command, ...args]);
    const exitCode = args.at(-1) === this.probePath ? this.probeExitCode : 1;
    return {
      command,
      args,
      stdout: "",
      stderr: exitCode > 1 ? `probe diagnostic ${exitCode}` : "",
      exitCode
    };
  }
}

function workspaceFixture(root: string): WorkspaceRecord {
  return {
    schemaVersion: 5,
    name: "work-1",
    projectId: "project-id",
    projectName: "project",
    rootRepositoryAlias: "root",
    rootRef: "refs/heads/main",
    rootCommit: COMMIT,
    rootSnapshotPath: join(root, "assets", "project-roots", "project-id", COMMIT),
    repositorySnapshot: repositorySnapshot(),
    projectPath: "/workspace/project",
    phase: "ready",
    profiles: ["development"],
    composeProjectName: "dim-work-1",
    containerName: "dim-ws-work-1",
    networkName: "dim-control",
    dockerVolumeName: "dim-ws-work-1-docker",
    runtimeBackend: "sysbox",
    kvm: false,
    cpuCount: "2",
    memory: "4g",
    pidsLimit: "2048",
    routes: [],
    gitUserName: "Agent",
    gitUserEmail: "agent@example.invalid",
    gitBaseUrl: "http://dim-gitea:3000/dim-project",
    hostAliases: {},
    projectManifestPath: "/run/dim/project.json",
    createdAt: "now",
    updatedAt: "now"
  };
}

describe("lifecycle file probes", () => {
  let root = "";
  let record: WorkspaceRecord;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-lifecycle-probe-"));
    record = workspaceFixture(root);
    await mkdir(record.rootSnapshotPath, { recursive: true });
    await new LifecycleState(root).claimWorkspace(record);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([[0, true], [1, false]] as const)(
    "treats probe exit %i as file presence %s",
    async (exitCode, expected) => {
      // Given
      const runner = new LifecycleProbeRunner(".dim/setup.sh", exitCode);

      // When
      const present = await lifecycleFileExists(runner, record, ".dim/setup.sh");

      // Then
      expect(present).toBe(expected);
    }
  );

  it.each(EXCEPTIONAL_EXIT_CODES)("rejects setup probe exit %i before setup dispatch", async (exitCode) => {
    // Given
    const runner = new LifecycleProbeRunner(".dim/setup.sh", exitCode);

    // When
    const setup = runProjectSetup(runner, record, false, false);

    // Then
    await expect(setup).rejects.toThrow(`probe diagnostic ${exitCode}`);
    expect(runner.streamingCalls).toHaveLength(0);
  });

  it.each(EXCEPTIONAL_EXIT_CODES)("rejects teardown probe exit %i before teardown dispatch", async (exitCode) => {
    // Given
    const runner = new LifecycleProbeRunner(".dim/teardown.sh", exitCode);

    // When
    const teardown = runProjectTeardown(runner, record, false);

    // Then
    await expect(teardown).rejects.toThrow(`probe diagnostic ${exitCode}`);
    expect(runner.streamingCalls).toHaveLength(0);
  });

  it.each(EXCEPTIONAL_EXIT_CODES)("rejects Compose probe exit %i before Compose dispatch", async (exitCode) => {
    // Given
    const runner = new LifecycleProbeRunner(".dim/docker-compose.yml", exitCode);

    // When
    const setup = runProjectSetup(runner, record, false, false);

    // Then
    await expect(setup).rejects.toThrow(`probe diagnostic ${exitCode}`);
    expect(runner.streamingCalls).toHaveLength(0);
  });

  it.each(EXCEPTIONAL_EXIT_CODES)(
    "rejects entrypoint probe exit %i before direct-command fallback dispatch",
    async (exitCode) => {
      // Given
      const runner = new LifecycleProbeRunner(".dim/entrypoint.sh", exitCode);

      // When
      const run = runWorkspace(runner, lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }), {
        name: record.name,
        command: ["codex"],
        interactive: false
      });

      // Then
      await expect(run).rejects.toThrow(`probe diagnostic ${exitCode}`);
      expect(runner.streamingCalls).toHaveLength(0);
    }
  );
});
