import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleState } from "../../../../core/packages/managed/src/lifecycleState.js";
import { lifecycleOptionsForBackend } from "../../../../core/packages/managed/src/lifecycleOptions.js";
import type { WorkspaceRecord } from "../../../../core/packages/managed/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { runWorkspace } from "../../../../core/packages/managed/src/workspaceLifecycle.js";
import { setupWorkspaceLocked } from "../../../../core/packages/managed/src/workspaceSetup.js";
import {
  workspaceAgentContainerLabels,
  workspaceAgentIdentity,
  workspaceAgentNetworkLabels,
  workspaceAgentVolumeLabels
} from "../../../../core/packages/managed/src/workspaceAgentRuntime.js";
import { workspaceContainerInspect } from "./workspaceOwnershipFixture.js";
import { nativeWorkspaceFixture } from "./nativeLifecycleFixture.js";

const imageId = `sha256:${"f".repeat(64)}`;
const agentId = "a".repeat(64);

describe("recommended workspace commands", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("runs the built-in shell in the isolated agent and initializes the exact checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-recommended-command-"));
    roots.push(root);
    const record = fixture();
    const snapshot = join(root, "assets", "native-project-roots", record.projectId, record.rootCommit);
    await mkdir(snapshot, { recursive: true });
    await new LifecycleState(root).claimWorkspace(record);
    const runner = new RecommendedRunner(record, snapshot);

    const exitCode = await runWorkspace(runner, lifecycleOptionsForBackend("sysbox", {
      DIM_STATE_ROOT: root,
      DIM_WORKSPACE_IMAGE: "dim-workspace:test"
    }), { name: record.name, command: ["shell"], interactive: true });

    expect(exitCode).toBe(0);
    expect(runner.runCalls.some((call) => call[1] === "run")).toBe(false);
    expect(runner.runCalls.some((call) => call[1] === "info" || call[1] === "network"
      || call.includes("dim-agent-checkout") || call.includes("DIM_AGENT_GIT_LISTEN_HOST=172.31.0.2"))).toBe(false);
    expect(runner.streamingCalls.at(-1)).toEqual(expect.arrayContaining([
      "docker", "exec", "--user", "dim", "--workdir", "/workspace", "--tty", agentId, "bash"
    ]));
  });

  it("runs a custom command directly in the isolated agent without a Project entrypoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-recommended-command-"));
    roots.push(root);
    const record = fixture();
    const snapshot = join(root, "assets", "native-project-roots", record.projectId, record.rootCommit);
    await mkdir(snapshot, { recursive: true });
    await new LifecycleState(root).claimWorkspace(record);
    const runner = new RecommendedRunner(record, snapshot);

    const exitCode = await runWorkspace(runner, lifecycleOptionsForBackend("sysbox", {
      DIM_STATE_ROOT: root,
      DIM_WORKSPACE_IMAGE: "dim-workspace:test"
    }), { name: record.name, command: ["custom", "printf", "ok"], interactive: false });

    expect(exitCode).toBe(0);
    expect(runner.streamingCalls.at(-1)).toEqual(expect.arrayContaining([
      "docker", "exec", "--user", "dim", "--workdir", "/workspace", agentId, "printf", "ok"
    ]));
  });

  it("reconciles and initializes the recommended agent before publishing ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-recommended-setup-"));
    roots.push(root);
    const record = { ...fixture(), phase: "creating" as const };
    const snapshot = join(root, "assets", "native-project-roots", record.projectId, record.rootCommit);
    await mkdir(snapshot, { recursive: true });
    const state = new LifecycleState(root);
    await state.claimWorkspace(record);
    const runner = new RecommendedRunner(record, snapshot, true, false, state);

    const result = await setupWorkspaceLocked(runner, lifecycleOptionsForBackend("sysbox", {
      DIM_STATE_ROOT: root,
      DIM_WORKSPACE_IMAGE: "dim-workspace:test"
    }), state, record);

    expect(result.phase).toBe("ready");
    expect(runner.runCalls).toContainEqual(expect.arrayContaining([
      "docker", "exec", "--env", `DIM_AGENT_ROOT_COMMIT=${record.rootCommit}`
    ]));
    expect(runner.phaseAtCheckout).toBe("setting-up");
    expect(runner.runCalls).toContainEqual([
      "docker", "exec", "outer-id", "node", "/usr/local/lib/dim/agent-git-relay.mjs", "phase", "ready"
    ]);
    await expect(state.readWorkspace(record.name)).resolves.toMatchObject({ phase: "ready" });
  });

  it("fails setup before agent creation when Sysbox is not registered", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-recommended-setup-"));
    roots.push(root);
    const record = { ...fixture(), phase: "setting-up" as const };
    const snapshot = join(root, "assets", "native-project-roots", record.projectId, record.rootCommit);
    await mkdir(snapshot, { recursive: true });
    const state = new LifecycleState(root);
    await state.claimWorkspace(record);
    const runner = new RecommendedRunner(record, snapshot, false, false);

    await expect(setupWorkspaceLocked(runner, lifecycleOptionsForBackend("sysbox", {
      DIM_STATE_ROOT: root,
      DIM_WORKSPACE_IMAGE: "dim-workspace:test"
    }), state, record)).rejects.toThrow(/sysbox-runc.*required/i);

    expect(runner.runCalls.some((call) => call[1] === "run")).toBe(false);
    await expect(state.readWorkspace(record.name)).resolves.toMatchObject({
      phase: "setup-error",
      error: expect.stringMatching(/sysbox-runc.*required/i)
    });
  });

  it("revokes a ready relay before a failed setting-up publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-recommended-setup-publication-")); roots.push(root);
    const record = fixture(); const snapshot = join(root, "assets", "native-project-roots", record.projectId, record.rootCommit);
    await mkdir(snapshot, { recursive: true });
    const state = new LifecycleState(root);
    await state.claimWorkspace(record);
    vi.spyOn(state, "writeWorkspace").mockRejectedValue(new Error("injected setting-up publication failure"));
    const runner = new RecommendedRunner(record, snapshot);

    await expect(setupWorkspaceLocked(runner, lifecycleOptionsForBackend("sysbox", {
      DIM_STATE_ROOT: root, DIM_WORKSPACE_IMAGE: "dim-workspace:test"
    }), state, record)).rejects.toThrow(/injected setting-up publication failure/);

    expect(runner.runCalls).toContainEqual([
      "docker", "exec", "outer-id", "node", "/usr/local/lib/dim/agent-git-relay.mjs", "phase", "setting-up"
    ]);
    expect(runner.runCalls.some((call) => call.includes("dim-agent-checkout"))).toBe(false);
  });

  it("does not lazily recreate a missing agent from the command path", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-recommended-command-"));
    roots.push(root);
    const record = fixture();
    const snapshot = join(root, "assets", "native-project-roots", record.projectId, record.rootCommit);
    await mkdir(snapshot, { recursive: true });
    const state = new LifecycleState(root);
    await state.claimWorkspace(record);
    const runner = new RecommendedRunner(record, snapshot, true, false);

    await expect(runWorkspace(runner, lifecycleOptionsForBackend("sysbox", {
      DIM_STATE_ROOT: root,
      DIM_WORKSPACE_IMAGE: "dim-workspace:test"
    }), { name: record.name, command: ["shell"], interactive: false })).rejects.toThrow(/not ready.*setup-error/i);

    expect(runner.runCalls.some((call) => call[1] === "run")).toBe(false);
    await expect(state.readWorkspace(record.name)).resolves.toMatchObject({
      phase: "setup-error",
      error: expect.stringMatching(/agent is not running/i)
    });
  });
});

class RecommendedRunner implements StreamingCommandRunner {
  readonly runCalls: string[][] = [];
  readonly streamingCalls: string[][] = [];
  readonly resources = new Set<string>();
  agentCreated: boolean;
  phaseAtCheckout: WorkspaceRecord["phase"] | undefined;

  constructor(
    private readonly record: WorkspaceRecord,
    private readonly snapshot: string,
    private readonly runtimeRegistered = true,
    agentCreated = true,
    private readonly state?: LifecycleState
  ) { this.agentCreated = agentCreated; }

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.runCalls.push([command, ...args]);
    if (args[0] === "container" && args[1] === "inspect" && args.at(-1)?.includes("HostConfig.NanoCpus")) {
      return result(command, args, args[2] === agentId
        ? "1500000000|3221225472|3221225472|1536"
        : "500000000|1073741824|1073741824|512");
    }
    if (args[0] === "info" && args.includes("{{json .Runtimes}}")) {
      return result(command, args, JSON.stringify(this.runtimeRegistered ? { "sysbox-runc": {} } : {}));
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === "outer-id"
      && args.includes(`{{(index .NetworkSettings.Networks "dim-agent-${this.record.name}").IPAddress}}`)) {
      return result(command, args, "172.31.0.2");
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === this.record.containerName) {
      return result(command, args, workspaceContainerInspect(this.record, { id: "outer-id", rootSnapshotPath: this.snapshot }));
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === `dim-agent-${this.record.name}`) {
      if (!this.agentCreated) return missing(command, args, "container", args[2]);
      return result(command, args, agentInspect(this.record));
    }
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "inspect") {
      const name = args[2] ?? "";
      if (!this.resources.has(name)) return missing(command, args, args[0], name);
      const labels = args[0] === "network"
        ? workspaceAgentNetworkLabels(this.record)
        : workspaceAgentVolumeLabels(this.record, name.endsWith("-home")
          ? "agent-home"
          : name.endsWith("-docker") ? "agent-docker" : "agent-checkout");
      return result(command, args, jsonLabels(labels));
    }
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "create") {
      this.resources.add(args.at(-1) ?? "");
      return result(command, args);
    }
    if (args[0] === "image" && args[1] === "inspect") return result(command, args, imageId);
    if (args[0] === "run") {
      this.agentCreated = true;
      return result(command, args, agentId);
    }
    if (args[0] === "update") return result(command, args);
    if (args[0] === "network" && args[1] === "connect") return result(command, args);
    if (args[0] === "exec" && args.includes("test") && args.includes("-f")) {
      return { command, args, stdout: "", stderr: "", exitCode: 1 };
    }
    if (args[0] === "exec" && args.some((argument) => argument.endsWith("/agent-git-relay.mjs"))
      && args.at(-1) === "ensure") {
      return result(command, args, JSON.stringify({ schemaVersion: 1, status: "ready", pid: 123,
        processStart: "456", configHash: "a".repeat(64), host: "172.31.0.2", port: 19_419 }));
    }
    if (args[0] === "exec" && args.includes("dim-agent-checkout")) {
      this.phaseAtCheckout = (await this.state?.readWorkspace(this.record.name))?.phase;
      return result(command, args);
    }
    return result(command, args);
  }

  async runStreaming(command: string, args: string[]): Promise<number> {
    this.streamingCalls.push([command, ...args]);
    return 0;
  }
}

function fixture(): WorkspaceRecord {
  return nativeWorkspaceFixture({ environment: "recommended", gitUserName: "Agent", gitUserEmail: "agent@example.invalid",
    createdAt: "now", updatedAt: "now" });
}

function jsonLabels(labels: readonly string[]): string {
  return JSON.stringify(Object.fromEntries(labels.map((label) => label.split("=", 2))));
}

function agentInspect(record: WorkspaceRecord): string {
  const identity = workspaceAgentIdentity(record);
  return [
    agentId, "true", imageId, "sysbox-runc", "false", jsonLabels(workspaceAgentContainerLabels(record)),
    JSON.stringify([
      { Type: "volume", Name: identity.homeVolumeName, Source: `/docker/volumes/${identity.homeVolumeName}/_data`,
        Destination: "/home/dim", RW: true },
      { Type: "volume", Name: identity.checkoutVolumeName, Source: `/docker/volumes/${identity.checkoutVolumeName}/_data`,
        Destination: "/workspace", RW: true },
      { Type: "volume", Name: identity.dockerVolumeName, Source: `/docker/volumes/${identity.dockerVolumeName}/_data`,
        Destination: "/var/lib/docker", RW: true }
    ])
  ].join("|");
}

function result(command: string, args: string[], stdout = ""): CommandResult {
  return { command, args, stdout, stderr: "", exitCode: 0 };
}

function missing(command: string, args: string[], kind: string, name: string): CommandResult {
  return { command, args, stdout: "", stderr: `Error: No such ${kind}: ${name}`, exitCode: 1 };
}
