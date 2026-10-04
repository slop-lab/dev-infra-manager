import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ciRunner from "../../../../core/packages/core/src/ciRunner.js";
import { giteaCiCoordinator } from "../../../../core/packages/core/src/giteaCiCoordinator.js";
import { shutdownHost, startHost } from "../../../../core/packages/core/src/hostLifecycle.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { CiRunnerPhase } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import * as workspaceLifecycle from "../../../../core/packages/core/src/workspaceLifecycle.js";
import { ownedLabels } from "./ciRunnerContainerFixture.js";
import { StatefulContainerRunner } from "./ciRunnerContainerRunner.js";
import { claimTestGiteaService, ownedGiteaContainerInspect } from "./giteaServiceFixture.js";
import {
  HOST_PROJECT,
  HOST_QEMU_RUNNER,
  hostLifecycleOptions,
  hostRecord,
  workspaceRecord
} from "./hostLifecycleFixture.js";

vi.mock("../../../../core/packages/core/src/gitea.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/gitea.js")>(),
  ensureGitea: vi.fn(async () => {})
}));

vi.mock("../../../../core/packages/core/src/registryCache.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/registryCache.js")>(),
  ensureRegistryCache: vi.fn(async () => {})
}));

vi.mock("../../../../core/packages/core/src/aptCache.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/aptCache.js")>(),
  ensureAptCache: vi.fn(async () => {})
}));

describe("host lifecycle", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-host-lifecycle-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("stops managed infrastructure without removing containers or volumes", async () => {
    await claimTestGiteaService(root);
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        calls.push([command, ...args]);
        if (args.includes("inspect")) {
          if (args[2] === "dim-gitea") {
            return { command, args, stdout: `${ownedGiteaContainerInspect("owned-gitea-id", true)}\n`, stderr: "", exitCode: 0 };
          }
          const apt = args[2] === "dim-apt-cache";
          const id = apt ? "owned-apt-id" : "owned-registry-id";
          const resource = apt ? "apt-cache" : "registry-cache";
          const resourceId = apt ? "A".repeat(43) : "R".repeat(43);
          return { command, args, stdout: `${id}|true|dim|${"M".repeat(43)}|${resource}|${resourceId}|true\n`, stderr: "", exitCode: 0 };
        }
        if (args[0] === "container" && args[1] === "ls") {
          return { command, args, stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[0] === "stop") {
          return { command, args, stdout: `${args[1]}\n`, stderr: "", exitCode: 0 };
        }
        return { command, args, stdout: "", stderr: "unexpected command", exitCode: 1 };
      },
      async runStreaming() {
        throw new Error("no workspace should be stopped in this test");
      }
    };
    const options = hostLifecycleOptions(root);

    const result = await shutdownHost(runner, options);

    expect(result.phase).toBe("stopped");
    expect(calls.filter((call) => call[1] === "stop").map((call) => call[2])).toEqual([
      "owned-registry-id",
      "owned-apt-id",
      "owned-gitea-id"
    ]);
    expect(calls.flat().join(" ")).not.toMatch(/\b(?:rm|remove|down|prune)\b/);
    expect(calls.flat().join(" ")).not.toContain("volume");
  });

  it("does not inspect or stop an externally managed Gitea service", async () => {
    // Given
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        calls.push([command, ...args]);
        if (args[0] === "container" && args[1] === "ls") {
          return { command, args, stdout: "", stderr: "", exitCode: 0 };
        }
        if (args.includes("dim-registry-cache") || args.includes("dim-apt-cache")) {
          return { command, args, stdout: "", stderr: "no such container", exitCode: 1 };
        }
        throw new Error(`unexpected command: ${[command, ...args].join(" ")}`);
      },
      async runStreaming() {
        throw new Error("no workspace should be stopped in this test");
      }
    };
    const options = {
      ...hostLifecycleOptions(root),
      giteaConnection: { kind: "external" as const, file: "/run/secrets/gitea.json" }
    };

    // When
    const result = await shutdownHost(runner, options);

    // Then
    expect(result.phase).toBe("stopped");
    expect(calls.flat()).not.toContain("dim-gitea");
  });

  it("rejects a foreign managed-Git replacement during shutdown without stopping it", async () => {
    // Given
    await claimTestGiteaService(root);
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        calls.push([command, ...args]);
        if (args[0] === "container" && args[1] === "ls") {
          return { command, args, stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[0] === "container" && args[1] === "inspect" && args[2] === "dim-registry-cache") {
          return { command, args, stdout: "", stderr: "no such container", exitCode: 1 };
        }
        if (args[0] === "container" && args[1] === "inspect" && args[2] === "dim-apt-cache") {
          return { command, args, stdout: "", stderr: "no such container", exitCode: 1 };
        }
        if (args[0] === "container" && args[1] === "inspect" && args[2] === "dim-gitea") {
          return { command, args, stdout: `${ownedGiteaContainerInspect("foreign-gitea-id", true, false)}\n`, stderr: "", exitCode: 0 };
        }
        throw new Error(`unexpected command: ${[command, ...args].join(" ")}`);
      },
      async runStreaming() {
        throw new Error("no streaming command expected");
      }
    };

    // When
    const shutdown = shutdownHost(runner, hostLifecycleOptions(root));

    // Then
    await expect(shutdown).rejects.toThrow(/stop Gitea.*not managed by dim/);
    expect(calls.some((call) => call[1] === "stop")).toBe(false);
  });

  it("stops ephemeral pooled CI containers without persisting them as restart targets", async () => {
    // Given
    const name = "dim-ci-ordinary-host-a-primary-abcdef012345";
    await claimTestGiteaService(root);
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        calls.push([command, ...args]);
        const stdout = args[0] === "container" && args[1] === "ls" ? `${name}\n`
          : args[0] === "container" && args[1] === "inspect" && args[2] === "dim-gitea"
            ? `${ownedGiteaContainerInspect("owned-gitea-id", true)}\n`
            : args[0] === "container" && args[1] === "inspect" && args[2] === "dim-registry-cache"
              ? `owned-registry-id|true|dim|${"M".repeat(43)}|registry-cache|${"R".repeat(43)}|true\n`
              : args[0] === "container" && args[1] === "inspect" && args[2] === "dim-apt-cache"
                ? `owned-apt-id|true|dim|${"M".repeat(43)}|apt-cache|${"A".repeat(43)}|true\n`
            : args[0] === "container" && args[1] === "inspect"
              ? args[2] === name
                ? "owned-pool-id|true|dim|host-a|primary|claim-123|project-a|ci-ordinary-job\n"
                : `owned-${args[2] ?? "container"}-id|true|dim|infrastructure|infrastructure-v1|true\n`
              : "";
        return { command, args, stdout, stderr: "", exitCode: 0 };
      },
      async runStreaming() { return 0; }
    };

    // When
    const stopped = await shutdownHost(runner, hostLifecycleOptions(root));

    // Then
    expect(stopped.resumeManagedContainers).toEqual([]);
    expect(calls).toContainEqual([
      "docker", "container", "ls", "--filter", "label=dim.managed=true",
      "--filter", "label=dim.resource=ci-ordinary-job", "--format", "{{.Names}}"
    ]);
    expect(calls).toContainEqual(["docker", "container", "rm", "--force", "owned-pool-id"]);
  });

  it("starts managed infrastructure by its inspected immutable ID", async () => {
    const state = new LifecycleState(root);
    await state.writeHostLifecycle({
      ...hostRecord("stopped"),
      resumeManagedContainers: ["managed-service"]
    });
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        calls.push([command, ...args]);
        if (args.includes("inspect")) {
          return { command, args, stdout: "owned-service-id|true|dim|service|service-v1|false\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "start") {
          return { command, args, stdout: `${args[1]}\n`, stderr: "", exitCode: 0 };
        }
        return { command, args, stdout: "", stderr: "unexpected command", exitCode: 1 };
      },
      async runStreaming() {
        throw new Error("no streaming command expected");
      }
    };

    await startHost(runner, hostLifecycleOptions(root));

    expect(calls).toContainEqual(["docker", "start", "owned-service-id"]);
    expect(calls).not.toContainEqual(["docker", "start", "managed-service"]);
  });

  it("rejects a foreign same-name CI container instead of accepting a weak running-state inspection", async () => {
    // Given
    const state = new LifecycleState(root);
    const readyRunner = { ...HOST_QEMU_RUNNER, executor: { ...HOST_QEMU_RUNNER.executor, phase: "ready" as const } };
    await state.claimProject(HOST_PROJECT);
    await state.writeCiRunner(readyRunner);
    await state.writeHostLifecycle(hostRecord("stopping", {
      resumeWorkspaces: [],
      restartCiRunners: [{ project: readyRunner.projectName, name: readyRunner.name }]
    }));
    const labels = ownedLabels(readyRunner, readyRunner.executor)
      .map((label) => label === "dim.owner=dim" ? "dim.owner=foreign" : label);
    const runner = new StatefulContainerRunner();
    runner.add({ id: "foreign-ci-id", name: readyRunner.executor.supervisorName, labels, running: true });

    // When
    const start = startHost(runner, hostLifecycleOptions(root));

    // Then
    await expect(start).rejects.toThrow(/conflicts with DIM ownership/);
    const inspect = runner.calls.find((call) => call[1] === "container" && call[2] === "inspect");
    expect(inspect?.at(-1)).toContain("dim.digest");
    expect(runner.calls.some((call) => call[1] === "start" || call[1] === "stop")).toBe(false);
  });

  it("resumes workspace recovery on a second call without restarting an already recovered workspace", async () => {
    // Given
    const state = new LifecycleState(root);
    const phases = new Map([
      ["recovered", workspaceRecord("recovered", "stopped")],
      ["interrupted", workspaceRecord("interrupted", "setup-error")]
    ]);
    for (const workspace of phases.values()) await state.claimWorkspace(workspace);
    await state.writeHostLifecycle(hostRecord("stopped", {
      resumeWorkspaces: [...phases.keys()],
      restartCiRunners: []
    }));
    vi.spyOn(workspaceLifecycle, "showWorkspace").mockImplementation(async (_runner, _options, name) => phases.get(name) ?? workspaceRecord(name, "creating"));
    vi.spyOn(workspaceLifecycle, "startWorkspace").mockImplementation(async (_runner, _options, name) => {
      const ready = workspaceRecord(name, "ready");
      phases.set(name, ready);
      return ready;
    });
    let setupAttempts = 0;
    vi.spyOn(workspaceLifecycle, "setupWorkspace").mockImplementation(async (_runner, _options, name) => {
      setupAttempts += 1;
      if (setupAttempts === 1) throw new Error("setup interrupted");
      const ready = workspaceRecord(name, "ready");
      phases.set(name, ready);
      return ready;
    });

    // When / Then: the first call retains every target after partial recovery.
    await expect(startHost(new StatefulContainerRunner(), hostLifecycleOptions(root))).rejects.toThrow(/setup interrupted/);
    await expect(state.readHostLifecycle()).resolves.toMatchObject({
      phase: "error",
      resumeWorkspaces: ["recovered", "interrupted"]
    });

    // When / Then: the second call resumes only the interrupted target.
    await expect(startHost(new StatefulContainerRunner(), hostLifecycleOptions(root))).resolves.toMatchObject({
      phase: "ready",
      resumeWorkspaces: []
    });

    expect(workspaceLifecycle.startWorkspace).toHaveBeenCalledTimes(1);
    expect(workspaceLifecycle.startWorkspace).toHaveBeenCalledWith(expect.anything(), expect.anything(), "recovered");
    expect(workspaceLifecycle.setupWorkspace).toHaveBeenCalledTimes(2);
  });

  it("recovers an interrupted QEMU runner twice through inspected ownership-safe stops", async () => {
    // Given
    const state = new LifecycleState(root);
    await state.claimProject(HOST_PROJECT);
    await state.writeCiRunner(HOST_QEMU_RUNNER);
    await state.writeHostLifecycle(hostRecord("stopped", {
      resumeWorkspaces: [],
      restartCiRunners: [{ project: HOST_QEMU_RUNNER.projectName, name: HOST_QEMU_RUNNER.name }]
    }));
    const runner = new StatefulContainerRunner();
    runner.add({
      id: "owned-qemu-id",
      name: HOST_QEMU_RUNNER.executor.supervisorName,
      labels: ownedLabels(HOST_QEMU_RUNNER, HOST_QEMU_RUNNER.executor),
      running: true
    });
    vi.spyOn(giteaCiCoordinator, "removeWorkflowJobWebhook").mockResolvedValue();
    vi.spyOn(giteaCiCoordinator, "reconcileWorkflowJobWebhookTargets").mockResolvedValue();
    let starts = 0;
    vi.spyOn(ciRunner, "startCiRunner").mockImplementation(async (_runner, _options, target) => {
      starts += 1;
      const current = await state.readCiRunner(target.project, target.name);
      const phase: CiRunnerPhase = starts === 1 ? "error" : "ready";
      const updated = { ...current, executor: { ...current.executor, phase }, updatedAt: "later" };
      await state.writeCiRunner(updated);
      if (phase === "error") throw new Error("runner start interrupted");
      return updated;
    });

    // When / Then: the first ownership-safe normalization succeeds but runner start is interrupted.
    await expect(startHost(runner, hostLifecycleOptions(root))).rejects.toThrow(/runner start interrupted/);
    await expect(state.readHostLifecycle()).resolves.toMatchObject({ phase: "error", restartCiRunners: [{ project: "example", name: "capacity" }] });

    // When / Then: the retry safely normalizes the error-phase runner again and completes.
    await expect(startHost(runner, hostLifecycleOptions(root))).resolves.toMatchObject({ phase: "ready", restartCiRunners: [] });

    const stops = runner.calls.filter((call) => call[1] === "stop");
    expect(stops).toEqual([
      ["docker", "stop", "owned-qemu-id"],
      ["docker", "stop", "owned-qemu-id"]
    ]);
    expect(runner.calls.filter((call) => call[1] === "container" && call[2] === "inspect")
      .every((call) => call.at(-1)?.includes("dim.digest"))).toBe(true);
  });

  it("fails closed instead of dispatching a workspace that is still creating", async () => {
    // Given
    const state = new LifecycleState(root);
    await state.writeHostLifecycle(hostRecord("stopped", {
      resumeWorkspaces: ["creating"],
      restartCiRunners: []
    }));
    const creating = workspaceRecord("creating", "creating");
    await state.claimWorkspace(creating);
    vi.spyOn(workspaceLifecycle, "showWorkspace").mockResolvedValue(creating);
    vi.spyOn(workspaceLifecycle, "startWorkspace");
    vi.spyOn(workspaceLifecycle, "setupWorkspace");

    // When
    const start = startHost(new StatefulContainerRunner(), hostLifecycleOptions(root));

    // Then
    await expect(start).rejects.toThrow(/still creating/);
    expect(workspaceLifecycle.startWorkspace).not.toHaveBeenCalled();
    expect(workspaceLifecycle.setupWorkspace).not.toHaveBeenCalled();
    await expect(state.readHostLifecycle()).resolves.toMatchObject({
      phase: "error",
      resumeWorkspaces: ["creating"]
    });
  });

  it("leaves a ready CI runner untouched when an errored host has no restart intent", async () => {
    // Given
    const state = new LifecycleState(root);
    const readyRunner = { ...HOST_QEMU_RUNNER, executor: { ...HOST_QEMU_RUNNER.executor, phase: "ready" as const } };
    await state.claimProject(HOST_PROJECT);
    await state.writeCiRunner(readyRunner);
    await state.writeHostLifecycle(hostRecord("error", {
      resumeWorkspaces: [],
      restartCiRunners: []
    }));
    const runner = new StatefulContainerRunner();
    vi.spyOn(ciRunner, "startCiRunner");

    // When
    const result = await startHost(runner, hostLifecycleOptions(root));

    // Then
    expect(result.phase).toBe("ready");
    expect(runner.calls).toEqual([]);
    expect(ciRunner.startCiRunner).not.toHaveBeenCalled();
  });
});
