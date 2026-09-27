import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredDimAdminController } from "../../../../core/packages/core/src/adminController.js";
import { withHostRuntimeAdmission } from "../../../../core/packages/core/src/hostAdminAdmission.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { registerPlugins, type RegisteredDimPlugins } from "../../../../core/packages/core/src/plugin.js";
import { protectedRootSnapshotPath } from "../../../../core/packages/core/src/protectedRootSnapshot.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { WORKSPACE_RUNTIME_CONFIG_VERSION } from "../../../../core/packages/core/src/workspaceLifecycleTypes.js";
import { workspaceContainerLabels } from "../../../../core/packages/core/src/workspaceResourceOwnership.js";
import { hostLifecycleOptions, workspaceRecord } from "./hostLifecycleFixture.js";

class Barrier {
  readonly wait: Promise<void>;
  readonly #openBarrier: () => void;

  constructor() {
    let openBarrier: () => void = () => undefined;
    this.wait = new Promise((resolve) => { openBarrier = resolve; });
    this.#openBarrier = openBarrier;
  }

  open(): void {
    this.#openBarrier();
  }
}

class AdmissionLock {
  held = false;

  async acquire(): Promise<() => Promise<void>> {
    if (this.held) throw new Error("host admission remained held by another runtime session");
    this.held = true;
    return async () => { this.held = false; };
  }
}

class RuntimeRunner implements StreamingCommandRunner {
  readonly streams: string[] = [];
  readonly #streamWaiters = new Map<number, Barrier>();
  readonly #finish = new Barrier();

  constructor(private readonly stateRoot: string) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    const container = args[2] ?? "";
    const record = workspaceRecord(container.replace("dim-ws-", ""), "ready");
    const labels = workspaceContainerLabels(record).map((label) => label.slice(label.indexOf("=") + 1));
    const mounts = JSON.stringify([{
      Type: "bind",
      Source: protectedRootSnapshotPath(this.stateRoot, record.projectId, record.rootCommit),
      Destination: "/run/dim/project-root",
      RW: false
    }]);
    return result(command, args, [container, "true", ...labels, String(WORKSPACE_RUNTIME_CONFIG_VERSION), mounts].join("|"));
  }

  async runStreaming(command: string, args: string[]): Promise<number> {
    this.streams.push(args.find((argument) => argument.startsWith("dim-ws-")) ?? command);
    this.#streamWaiters.get(this.streams.length)?.open();
    await this.#finish.wait;
    return 0;
  }

  waitForStreams(expected: number): Promise<void> {
    if (this.streams.length >= expected) return Promise.resolve();
    const barrier = new Barrier();
    this.#streamWaiters.set(expected, barrier);
    return barrier.wait;
  }

  finish(): void {
    this.#finish.open();
  }
}

describe("admin runtime admission", () => {
  const servers: Server[] = [];
  const roots: string[] = [];
  const pluginSets: RegisteredDimPlugins[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.all(pluginSets.map((plugins) => plugins.dispose()));
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  it("releases host admission before independent workspace command streams finish", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-runtime-admission-"));
    roots.push(root);
    const state = new LifecycleState(root);
    await state.claimWorkspace(workspaceRecord("first", "ready"));
    await state.claimWorkspace(workspaceRecord("second", "ready"));
    const lock = new AdmissionLock();
    vi.spyOn(LifecycleState.prototype, "acquireHostLifecycleLock").mockImplementation(() => lock.acquire());
    const runner = new RuntimeRunner(root);
    const plugins = await registerPlugins([]);
    pluginSets.push(plugins);
    const server = configuredDimAdminController(hostLifecycleOptions(root), plugins, runner);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const base = `http://127.0.0.1:${address.port}`;

    // When
    const first = await startWorkspaceExec(base, "first");
    await runner.waitForStreams(1);

    // Then
    expect(lock.held).toBe(false);
    const second = await startWorkspaceExec(base, "second");
    await runner.waitForStreams(2);
    expect(runner.streams).toEqual(["dim-ws-first", "dim-ws-second"]);

    runner.finish();
    await expect(sessionEvents(base, first)).resolves.toMatch(/event: result/);
    await expect(sessionEvents(base, second)).resolves.toMatch(/event: result/);
  });

  it("rejects runtime dispatch when short admission observes a stopped host", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-runtime-admission-"));
    roots.push(root);
    const state = new LifecycleState(root);
    await state.writeHostLifecycle({
      schemaVersion: 2,
      phase: "stopped",
      resumeWorkspaces: [],
      restartCiRunners: [],
      resumeManagedContainers: [],
      updatedAt: "now"
    });
    let dispatched = false;

    // When
    const operation = withHostRuntimeAdmission(hostLifecycleOptions(root), async () => { dispatched = true; });

    // Then
    await expect(operation).rejects.toThrow("DIM host is stopped");
    expect(dispatched).toBe(false);
  });
});

async function startWorkspaceExec(base: string, name: string): Promise<string> {
  const response = await fetch(`${base}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "workspace.exec", input: { name, command: ["sh"] } })
  });
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "string") {
    throw new Error("session response is missing an id");
  }
  return body.id;
}

async function sessionEvents(base: string, id: string): Promise<string> {
  return await (await fetch(`${base}/v1/sessions/${id}/events`)).text();
}

function result(command: string, args: string[], stdout: string): CommandResult {
  return { command, args, stdout, stderr: "", exitCode: 0 };
}
