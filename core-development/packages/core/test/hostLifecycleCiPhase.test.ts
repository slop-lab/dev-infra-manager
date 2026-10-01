import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ciRunner from "../../../../core/packages/core/src/ciRunner.js";
import { giteaCiCoordinator } from "../../../../core/packages/core/src/giteaCiCoordinator.js";
import { startHost } from "../../../../core/packages/core/src/hostLifecycle.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { ownedLabels } from "./ciRunnerContainerFixture.js";
import { StatefulContainerRunner } from "./ciRunnerContainerRunner.js";
import { HOST_PROJECT, HOST_QEMU_RUNNER, hostLifecycleOptions, hostRecord } from "./hostLifecycleFixture.js";

vi.mock("../../../../core/packages/core/src/gitea.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/gitea.js")>(),
  ensureGitea: vi.fn(async () => {})
}));

vi.mock("../../../../core/packages/core/src/registryCache.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/registryCache.js")>(),
  ensureRegistryCache: vi.fn(async () => {})
}));

describe("host lifecycle CI phase recovery", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-host-ci-phase-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("normalizes a ready QEMU runner when host shutdown was interrupted", async () => {
    // Given
    const state = new LifecycleState(root);
    const readyRecord = {
      ...HOST_QEMU_RUNNER,
      executor: { ...HOST_QEMU_RUNNER.executor, phase: "ready" as const }
    };
    await state.claimProject(HOST_PROJECT);
    await state.writeCiRunner(readyRecord);
    await state.writeHostLifecycle(hostRecord("stopping", {
      resumeWorkspaces: [],
      restartCiRunners: [{ project: readyRecord.projectName, name: readyRecord.name }]
    }));
    const runner = new StatefulContainerRunner();
    runner.add({
      id: "inspected-qemu-id",
      name: readyRecord.executor.supervisorName,
      labels: ownedLabels(readyRecord, readyRecord.executor),
      running: true
    });
    vi.spyOn(giteaCiCoordinator, "removeWorkflowJobWebhook").mockResolvedValue();
    vi.spyOn(giteaCiCoordinator, "reconcileWorkflowJobWebhookTargets").mockResolvedValue();
    vi.spyOn(ciRunner, "startCiRunner").mockImplementation(async (_runner, _options, target) => {
      const stopped = await state.readCiRunner(target.project, target.name);
      const started = { ...stopped, executor: { ...stopped.executor, phase: "ready" as const } };
      await state.writeCiRunner(started);
      return started;
    });

    // When
    const result = await startHost(runner, hostLifecycleOptions(root));

    // Then
    const inspect = runner.calls.find((call) => call[1] === "container" && call[2] === "inspect");
    expect(inspect).toEqual([
      "docker", "container", "inspect", readyRecord.executor.supervisorName,
      "--format", expect.stringContaining("dim.digest")
    ]);
    expect(runner.calls).toContainEqual(["docker", "stop", "inspected-qemu-id"]);
    expect(runner.calls).not.toContainEqual(["docker", "stop", readyRecord.executor.supervisorName]);
    expect(ciRunner.startCiRunner).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ phase: "ready", restartCiRunners: [] });
    await expect(state.readCiRunner(readyRecord.projectName, readyRecord.name))
      .resolves.toMatchObject({ executor: { kind: "qemu", phase: "ready" } });
  });

  it.each(["stopped", "starting", "error"] as const)(
    "clears restart intent without cycling a ready QEMU runner on a %s retry",
    async (phase) => {
      // Given
      const state = new LifecycleState(root);
      const readyRecord = {
        ...HOST_QEMU_RUNNER,
        executor: { ...HOST_QEMU_RUNNER.executor, phase: "ready" as const }
      };
      await state.claimProject(HOST_PROJECT);
      await state.writeCiRunner(readyRecord);
      await state.writeHostLifecycle(hostRecord(phase, {
        resumeWorkspaces: [],
        restartCiRunners: [{ project: readyRecord.projectName, name: readyRecord.name }]
      }));
      const runner = new StatefulContainerRunner();
      runner.add({
        id: "inspected-qemu-id",
        name: readyRecord.executor.supervisorName,
        labels: ownedLabels(readyRecord, readyRecord.executor),
        running: true
      });
      vi.spyOn(giteaCiCoordinator, "removeWorkflowJobWebhook").mockResolvedValue();
      vi.spyOn(giteaCiCoordinator, "reconcileWorkflowJobWebhookTargets").mockResolvedValue();
      vi.spyOn(ciRunner, "startCiRunner").mockResolvedValue(readyRecord);

      // When
      const result = await startHost(runner, hostLifecycleOptions(root));

      // Then
      expect({
        result,
        containerTransitions: runner.calls.filter((call) => call[1] === "stop" || call[1] === "start"),
        runnerStarts: vi.mocked(ciRunner.startCiRunner).mock.calls.length
      }).toMatchObject({
        result: { phase: "ready", restartCiRunners: [] },
        containerTransitions: [],
        runnerStarts: 0
      });
    }
  );

  describe.each(["stopped", "starting", "stopping", "error"] as const)(
    "from %s host entry",
    (entryPhase) => {
      it("starts a stopped runner without stop normalization", async () => {
        // Given
        const state = new LifecycleState(root);
        const stoppedRecord = {
          ...HOST_QEMU_RUNNER,
          executor: { ...HOST_QEMU_RUNNER.executor, phase: "stopped" as const }
        };
        await state.claimProject(HOST_PROJECT);
        await state.writeCiRunner(stoppedRecord);
        await state.writeHostLifecycle(hostRecord(entryPhase, {
          resumeWorkspaces: [],
          restartCiRunners: [{ project: stoppedRecord.projectName, name: stoppedRecord.name }]
        }));
        const runner = new StatefulContainerRunner();
        vi.spyOn(ciRunner, "startCiRunner").mockResolvedValue({
          ...stoppedRecord,
          executor: { ...stoppedRecord.executor, phase: "ready" }
        });

        // When
        await startHost(runner, hostLifecycleOptions(root));

        // Then
        expect(runner.calls).toEqual([]);
        expect(ciRunner.startCiRunner).toHaveBeenCalledOnce();
      });

      it.each(["creating", "error"] as const)(
        "normalizes a %s runner through ownership-safe stop then start",
        async (runnerPhase) => {
          // Given
          const state = new LifecycleState(root);
          const recoverableRecord = {
            ...HOST_QEMU_RUNNER,
            executor: { ...HOST_QEMU_RUNNER.executor, phase: runnerPhase }
          };
          await state.claimProject(HOST_PROJECT);
          await state.writeCiRunner(recoverableRecord);
          await state.writeHostLifecycle(hostRecord(entryPhase, {
            resumeWorkspaces: [],
            restartCiRunners: [{ project: recoverableRecord.projectName, name: recoverableRecord.name }]
          }));
          const runner = new StatefulContainerRunner();
          runner.add({
            id: "inspected-qemu-id",
            name: recoverableRecord.executor.supervisorName,
            labels: ownedLabels(recoverableRecord, recoverableRecord.executor),
            running: true
          });
          const events: string[] = [];
          const run = runner.run.bind(runner);
          vi.spyOn(runner, "run").mockImplementation(async (command, args) => {
            if (args[0] === "stop") events.push("stop");
            return run(command, args);
          });
          vi.spyOn(giteaCiCoordinator, "removeWorkflowJobWebhook").mockResolvedValue();
          vi.spyOn(giteaCiCoordinator, "reconcileWorkflowJobWebhookTargets").mockResolvedValue();
          vi.spyOn(ciRunner, "startCiRunner").mockImplementation(async () => {
            events.push("start");
            return { ...recoverableRecord, executor: { ...recoverableRecord.executor, phase: "ready" } };
          });

          // When
          await startHost(runner, hostLifecycleOptions(root));

          // Then
          expect(events).toEqual(["stop", "start"]);
          expect(runner.calls).toContainEqual(["docker", "stop", "inspected-qemu-id"]);
          expect(runner.calls).not.toContainEqual(["docker", "stop", recoverableRecord.executor.supervisorName]);
        }
      );
    }
  );
});
