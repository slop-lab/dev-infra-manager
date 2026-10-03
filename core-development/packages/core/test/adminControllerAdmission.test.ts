import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredDimAdminController } from "../../../../core/packages/core/src/adminController.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { RegisteredDimPlugins } from "../../../../core/packages/core/src/plugin.js";
import { DIM_PLUGIN_API_VERSION, registerPlugin, registerPlugins } from "../../../../core/packages/core/src/plugin.js";
import { registerHostMirrorProvider } from "../../../../core/packages/core/src/hostMirrorProvider.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import {
  claimTestGiteaService,
  ownedGiteaContainerInspect,
  ownedGiteaResourceInspect
} from "./giteaServiceFixture.js";
import { hostLifecycleOptions, hostRecord, TEST_HOST_MIRROR_PROVIDER } from "./hostLifecycleFixture.js";

vi.mock("../../../../core/packages/core/src/registryCache.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/registryCache.js")>(),
  ensureRegistryCache: vi.fn(async () => {})
}));

vi.mock("../../../../core/packages/core/src/aptCache.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/aptCache.js")>(),
  ensureAptCache: vi.fn(async () => {})
}));

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

class DeterministicLock {
  readonly events: string[] = [];
  attempts = 0;
  #held = false;
  readonly #waiters: Barrier[] = [];
  readonly #attemptWaiters = new Map<number, Barrier>();

  get held(): boolean {
    return this.#held;
  }

  async acquire(): Promise<() => Promise<void>> {
    this.attempts += 1;
    this.#attemptWaiters.get(this.attempts)?.open();
    const attempt = this.attempts;
    if (this.#held) {
      const waiter = new Barrier();
      this.#waiters.push(waiter);
      await waiter.wait;
    }
    this.#held = true;
    this.events.push(`acquired:${attempt}`);
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      this.events.push(`released:${attempt}`);
      this.#held = false;
      this.#waiters.shift()?.open();
    };
  }

  waitForAttempt(expected: number): Promise<void> {
    if (this.attempts >= expected) return Promise.resolve();
    const barrier = new Barrier();
    this.#attemptWaiters.set(expected, barrier);
    return barrier.wait;
  }
}

class AdminRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];
  readonly snapshotReached = new Barrier();
  readonly allowSnapshot = new Barrier();

  constructor(private readonly blockSnapshot = false) {}

  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if (options.signal !== undefined && !options.signal.aborted) {
      await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
    }
    if (args[0] === "container" && args[1] === "ls") {
      this.snapshotReached.open();
      if (this.blockSnapshot) await this.allowSnapshot.wait;
      return result(command, args);
    }
    if (args[0] === "container" && args[1] === "inspect") {
      if (args[2] === "dim-gitea") {
        return result(command, args, `${ownedGiteaContainerInspect("gitea-container-id", true)}\n`);
      }
      return { ...result(command, args), stderr: `Error: No such container: ${args[2]}`, exitCode: 1 };
    }
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "inspect") {
      return result(command, args, `${ownedGiteaResourceInspect(args[0])}\n`);
    }
    if (args[0] === "exec" && args.some((argument) => argument.includes("/data/dim/credentials.json"))) {
      return result(command, args, JSON.stringify({
        adminUsername: "admin", adminPassword: "admin-secret",
        writerUsername: "writer", writerPassword: "writer-secret",
        maintainerUsername: "maintainer", maintainerPassword: "maintainer-secret"
      }));
    }
    if (args[0] === "exec" && args.some((argument) => argument.includes("awk"))) {
      return result(command, args, "true\n");
    }
    return result(command, args, "ok\n");
  }

  async runStreaming(): Promise<number> {
    return 0;
  }
}

describe("admin host admission", () => {
  const servers: Server[] = [];
  const roots: string[] = [];
  const pluginSets: RegisteredDimPlugins[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.all(pluginSets.map((plugins) => plugins.dispose()));
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    servers.length = 0;
    roots.length = 0;
    pluginSets.length = 0;
  });

  it("holds plugin admission until its operation finishes before shutdown acquires the lock", async () => {
    // Given
    const root = await stateRoot();
    const lock = new DeterministicLock();
    vi.spyOn(LifecycleState.prototype, "acquireHostLifecycleLock").mockImplementation(() => lock.acquire());
    const entered = new Barrier();
    const finish = new Barrier();
    let heldAtEntry = false;
    let heldAtCompletion = false;
    const plugins = await testPlugin(async () => {
      heldAtEntry = lock.held;
      entered.open();
      await finish.wait;
      heldAtCompletion = lock.held;
      lock.events.push("plugin-complete");
      return { body: { ok: true } };
    });
    const runner = new AdminRunner();
    const base = await startServer(root, plugins, runner);

    // When
    const pluginResponse = fetch(`${base}/v1/test`, { method: "POST" });
    await entered.wait;
    const attemptsBeforeShutdown = lock.attempts;
    const shutdownResponse = fetch(`${base}/v1/call/host.shutdown`, { method: "POST", body: "{}" });
    await lock.waitForAttempt(attemptsBeforeShutdown + 1);
    finish.open();

    // Then
    expect((await pluginResponse).status).toBe(200);
    expect((await shutdownResponse).status).toBe(200);
    expect(heldAtEntry).toBe(true);
    expect(heldAtCompletion).toBe(true);
    expect(lock.events.indexOf("plugin-complete")).toBeLessThan(lock.events.indexOf("acquired:2"));
  });

  it("rereads host state after queued plugin admission and rejects without dispatch", async () => {
    // Given
    const root = await stateRoot();
    const lock = new DeterministicLock();
    vi.spyOn(LifecycleState.prototype, "acquireHostLifecycleLock").mockImplementation(() => lock.acquire());
    const handlerEntered = new Barrier();
    let handlerCalls = 0;
    const plugins = await testPlugin(async () => {
      handlerCalls += 1;
      handlerEntered.open();
      return { body: { ok: true } };
    });
    const runner = new AdminRunner(true);
    const base = await startServer(root, plugins, runner);

    // When
    const shutdown = fetch(`${base}/v1/call/host.shutdown`, { method: "POST", body: "{}" });
    await runner.snapshotReached.wait;
    const response = fetch(`${base}/v1/test`, { method: "POST" });
    await Promise.race([lock.waitForAttempt(2), handlerEntered.wait]);
    runner.allowSnapshot.open();

    // Then
    expect((await shutdown).status).toBe(200);
    expect((await response).status).toBe(503);
    expect(handlerCalls).toBe(0);
  });

  it("admits streamed builtins during execution while control and status routes remain available", async () => {
    // Given
    const root = await stateRoot();
    const state = new LifecycleState(root);
    const allowAdmission = new Barrier();
    vi.spyOn(LifecycleState.prototype, "acquireHostLifecycleLock").mockImplementation(async () => {
      await allowAdmission.wait;
      await state.writeHostLifecycle(hostRecord("stopped"));
      return async () => undefined;
    });
    const runner = new AdminRunner();
    const plugins = await registerPlugins([]);
    pluginSets.push(plugins);
    const base = await startServer(root, plugins, runner);

    // When
    const started = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "doctor", input: {} })
    });
    const id = sessionId(await started.json());
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    expect((await fetch(`${base}/v1`)).status).toBe(200);
    expect((await fetch(`${base}/v1/call/host.status`, { method: "POST", body: "{}" })).status).toBe(200);
    expect((await fetch(`${base}/v1/sessions/${id}/input`, {
      method: "POST",
      body: JSON.stringify({ data: Buffer.from("input").toString("base64") })
    })).status).toBe(204);
    expect((await fetch(`${base}/v1/sessions/${id}`, { method: "DELETE" })).status).toBe(204);
    allowAdmission.open();

    // Then
    const events = await (await fetch(`${base}/v1/sessions/${id}/events`)).text();
    expect(events).toMatch(/event: error/);
    expect(runner.calls).toEqual([]);
  });

  it("lets host start and shutdown acquire only their own lifecycle lock", async () => {
    // Given
    const root = await stateRoot();
    let acquisitions = 0;
    vi.spyOn(LifecycleState.prototype, "acquireHostLifecycleLock").mockImplementation(async () => {
      acquisitions += 1;
      return async () => undefined;
    });
    const fetchImplementation = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
      String(input).startsWith("http://gitea:3000/")
        ? Promise.resolve(new Response(null, { status: 200 }))
        : fetchImplementation(input, init));
    const plugins = await registerPlugin({
      name: "test.host-mirrors",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register(host) { registerHostMirrorProvider(host, TEST_HOST_MIRROR_PROVIDER); }
    });
    pluginSets.push(plugins);
    const base = await startServer(root, plugins, new AdminRunner());

    // When
    const started = await fetch(`${base}/v1/call/host.start`, { method: "POST", body: "{}" });
    const stopped = await fetch(`${base}/v1/call/host.shutdown`, { method: "POST", body: "{}" });

    // Then
    expect(started.status).toBe(200);
    expect(stopped.status).toBe(200);
    expect(acquisitions).toBe(2);
  });

  async function stateRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "dim-admin-admission-"));
    roots.push(root);
    return root;
  }

  async function testPlugin(handle: () => Promise<{ body: { ok: boolean } }>): Promise<RegisteredDimPlugins> {
    const plugins = await registerPlugin({
      name: "test.admin-admission",
      apiVersion: DIM_PLUGIN_API_VERSION,
      register(host) {
        host.registerAdminRoute({ method: "POST", path: "/test", summary: "Test admission", handle });
      }
    });
    pluginSets.push(plugins);
    return plugins;
  }

  async function startServer(root: string, plugins: RegisteredDimPlugins, runner: StreamingCommandRunner): Promise<string> {
    await claimTestGiteaService(root);
    const server = configuredDimAdminController(hostLifecycleOptions(root), plugins, runner);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    return `http://127.0.0.1:${address.port}`;
  }
});

function result(command: string, args: string[], stdout = ""): CommandResult {
  return { command, args, stdout, stderr: "", exitCode: 0 };
}

function sessionId(value: unknown): string {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") {
    throw new Error("session response is missing an id");
  }
  return value.id;
}
