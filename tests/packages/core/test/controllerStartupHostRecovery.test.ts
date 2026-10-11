import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileReadyHostManagedGit } from "../../../../core/packages/core/src/hostLifecycle.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { claimTestGiteaService } from "./giteaServiceFixture.js";
import { hostLifecycleOptions, hostRecord } from "./hostLifecycleFixture.js";

class Barrier {
  readonly wait: Promise<void>;
  readonly #open: () => void;

  constructor() {
    let open = (): void => undefined;
    this.wait = new Promise((resolve) => { open = resolve; });
    this.#open = open;
  }

  open(): void {
    this.#open();
  }
}

class RejectingRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    throw new Error(`unexpected command: ${[command, ...args].join(" ")}`);
  }

  async runStreaming(): Promise<number> {
    throw new Error("no streaming command expected");
  }
}

describe("controller startup host recovery", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-controller-startup-host-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("does not bootstrap managed Git when no service record exists", async () => {
    // Given
    const state = new LifecycleState(root);
    const runner = new RejectingRunner();

    // When
    await reconcileReadyHostManagedGit(runner, hostLifecycleOptions(root));

    // Then
    expect(runner.calls).toEqual([]);
    await expect(state.readHostLifecycle()).resolves.toBeUndefined();
  });

  it("does not reconcile Git or replay recovery when shutdown wins the host lock", async () => {
    // Given
    const state = new LifecycleState(root);
    await state.writeHostLifecycle(hostRecord("ready"));
    await claimTestGiteaService(root);
    const releaseShutdown = await state.acquireHostLifecycleLock();
    const lockAttempted = new Barrier();
    const acquireHostLifecycleLock = LifecycleState.prototype.acquireHostLifecycleLock;
    vi.spyOn(LifecycleState.prototype, "acquireHostLifecycleLock").mockImplementation(function (this: LifecycleState) {
      lockAttempted.open();
      return acquireHostLifecycleLock.call(this);
    });
    const runner = new RejectingRunner();

    // When
    const startup = reconcileReadyHostManagedGit(runner, hostLifecycleOptions(root));
    await lockAttempted.wait;
    await state.writeHostLifecycle({
      ...hostRecord("stopped", {
        resumeWorkspaces: ["stopped-workspace", "starting-workspace"],
        restartCiRunners: [{ project: "project", name: "stopped-runner" }]
      }),
      resumeManagedContainers: ["starting-service"]
    });
    await releaseShutdown();

    // Then
    await expect(startup).resolves.toBeUndefined();
    expect(runner.calls).toEqual([]);
    await expect(state.readHostLifecycle()).resolves.toMatchObject({
      phase: "stopped",
      resumeWorkspaces: ["stopped-workspace", "starting-workspace"],
      restartCiRunners: [{ project: "project", name: "stopped-runner" }],
      resumeManagedContainers: ["starting-service"]
    });
  });
});
