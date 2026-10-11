import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureGitea } from "../../../../core/packages/core/src/gitea.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { CommandResult, CommandRunner } from "../../../../core/packages/core/src/types.js";
import { GITEA_CREDENTIALS } from "./giteaOrganizationPolicyFixture.js";
import {
  claimTestGiteaService,
  ownedGiteaContainerInspect,
  ownedGiteaResourceInspect,
  TEST_GITEA_SERVICE
} from "./giteaServiceFixture.js";
import { hostLifecycleOptions } from "./hostLifecycleFixture.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => ({ address: "127.0.0.1", family: 4 }))
}));

type ContainerMode =
  | "missing"
  | "owned-running"
  | "owned-stopped"
  | "foreign"
  | "drift"
  | "missing-network"
  | "missing-volume"
  | "wrong-image-id"
  | "wrong-network-id"
  | "wrong-volume-mount";

class RecoveryRunner implements CommandRunner {
  readonly calls: string[][] = [];
  failCredentials = false;
  private created = false;

  constructor(private readonly mode: ContainerMode) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "inspect") {
      if (this.mode === `missing-${args[0]}`) {
        const stderr = args[0] === "network"
          ? "Error response from daemon: network dim-control not found"
          : "Error response from daemon: get dim-gitea-data: no such volume";
        return result(command, args, "", 1, stderr);
      }
      return result(command, args, `${ownedGiteaResourceInspect(args[0])}\n`);
    }
    if (args[0] === "container" && args[1] === "inspect") return this.inspect(command, args);
    if (args[0] === "container" && args[1] === "create") {
      this.created = true;
      return result(command, args, "replacement-id\n");
    }
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "create") {
      return result(command, args, `${args[0]}-replacement-id\n`);
    }
    if (args[0] === "exec" && args.some((argument) => argument.includes("/data/dim/credentials.json"))) {
      return this.failCredentials
        ? result(command, args, "", 1, "injected credential interruption")
        : result(command, args, JSON.stringify(GITEA_CREDENTIALS));
    }
    if (args[0] === "exec" && args.some((argument) => argument.includes("awk"))) {
      return result(command, args, "true\n");
    }
    if (args[0] === "start" || args[0] === "restart" || args[0] === "exec") return result(command, args);
    return result(command, args, "", 1, "unexpected command");
  }

  private inspect(command: string, args: string[]): CommandResult {
    if (this.mode === "missing" && !this.created) {
      return result(command, args, "", 1, `Error: No such container: ${args[2] ?? "dim-gitea"}`);
    }
    if (this.mode === "foreign") {
      return result(command, args, `${ownedGiteaContainerInspect("foreign-id", true, false)}\n`);
    }
    const running = !this.created && this.mode !== "owned-stopped";
    let inspected = ownedGiteaContainerInspect(this.created ? "replacement-id" : "owned-id", running);
    if (this.mode === "drift") inspected = inspected.replace("172.20.0.2", "172.20.0.99");
    if (this.mode === "wrong-image-id") inspected = inspected.replace(TEST_GITEA_SERVICE.imageId, `sha256:${"f".repeat(64)}`);
    if (this.mode === "wrong-network-id") inspected = inspected.replace(TEST_GITEA_SERVICE.networkId, "e".repeat(64));
    if (this.mode === "wrong-volume-mount") inspected = inspected.replace(TEST_GITEA_SERVICE.volumeName, "foreign-volume");
    return result(command, args, `${inspected}\n`);
  }
}

function result(command: string, args: string[], stdout = "", exitCode = 0, stderr = ""): CommandResult {
  return { command, args, stdout, stderr, exitCode };
}

const cleanup: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("managed Gitea endpoint recovery", () => {
  it("inspects a recreated owned container before starting it at the leased address", async () => {
    // Given
    const root = await stateRoot();
    await claimTestGiteaService(root);
    const runner = new RecoveryRunner("missing");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    // When
    const connection = await ensureGitea(runner, hostLifecycleOptions(root));

    // Then
    expect(connection).toMatchObject({ kind: "managed", endpointAddress: TEST_GITEA_SERVICE.endpointAddress });
    const creation = runner.calls.find((call) => call[1] === "container" && call[2] === "create");
    expect(creation).toEqual(expect.arrayContaining([
      "--ip", TEST_GITEA_SERVICE.endpointAddress,
      "--label", `dim.service-id=${TEST_GITEA_SERVICE.serviceId}`,
      "--label", `dim.resource-id=${TEST_GITEA_SERVICE.containerOwnershipId}`
    ]));
    expect(creation?.at(-1)).toBe(TEST_GITEA_SERVICE.imageId);
    const createdInspection = runner.calls.findIndex(
      (call) => call[1] === "container" && call[2] === "inspect" && call[3] === "replacement-id"
    );
    const createdStart = runner.calls.findIndex(
      (call) => call[1] === "start" && call[2] === "replacement-id"
    );
    expect(createdInspection).toBeGreaterThanOrEqual(0);
    expect(createdStart).toBeGreaterThan(createdInspection);
  });

  it("starts an owned stopped container only by immutable inspected ID", async () => {
    // Given
    const root = await stateRoot();
    await claimTestGiteaService(root);
    const runner = new RecoveryRunner("owned-stopped");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    // When
    await ensureGitea(runner, hostLifecycleOptions(root));

    // Then
    expect(runner.calls).toContainEqual(["docker", "start", "owned-id"]);
    expect(runner.calls).not.toContainEqual(["docker", "start", "dim-gitea"]);
  });

  it("fails closed when an established endpoint lease loses its data volume", async () => {
    // Given
    const root = await stateRoot();
    await claimTestGiteaService(root);
    const runner = new RecoveryRunner("missing-volume");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    // When
    const recovery = ensureGitea(runner, hostLifecycleOptions(root));

    // Then
    await expect(recovery).rejects.toThrow(/volume.*missing/);
    const volumeInspection = runner.calls.findIndex(
      (call) => call[1] === "volume" && call[2] === "inspect"
    );
    expect(volumeInspection).toBeGreaterThanOrEqual(0);
    expect(runner.calls.slice(volumeInspection + 1)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    await expect(new LifecycleState(root).readGiteaService()).resolves.toMatchObject({
      serviceId: TEST_GITEA_SERVICE.serviceId,
      containerOwnershipId: TEST_GITEA_SERVICE.containerOwnershipId,
      networkOwnershipId: TEST_GITEA_SERVICE.networkOwnershipId,
      volumeOwnershipId: TEST_GITEA_SERVICE.volumeOwnershipId,
      endpointAddress: TEST_GITEA_SERVICE.endpointAddress
    });
  });

  it.each([
    { mode: "foreign" as const, message: /not managed by dim/ },
    { mode: "drift" as const, message: /endpoint address changed/ }
  ])("rejects $mode replacement without mutation", async ({ mode, message }) => {
    // Given
    const root = await stateRoot();
    await claimTestGiteaService(root);
    const runner = new RecoveryRunner(mode);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    // When
    const recovery = ensureGitea(runner, hostLifecycleOptions(root));

    // Then
    await expect(recovery).rejects.toThrow(message);
    expect(runner.calls.some((call) => ["run", "start", "restart", "exec"].includes(call[1] ?? ""))).toBe(false);
  });

  it.each(["network", "volume"] as const)(
    "rejects a missing established $resource without recreating infrastructure",
    async (resource) => {
      // Given
      const root = await stateRoot();
      await claimTestGiteaService(root);
      const runner = new RecoveryRunner(`missing-${resource}`);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

      // When
      const recovery = ensureGitea(runner, hostLifecycleOptions(root));

      // Then
      await expect(recovery).rejects.toThrow(/does not exist|missing/);
      expect(runner.calls.some((call) => ["create", "run", "start", "restart", "exec"].includes(call[2] ?? call[1] ?? ""))).toBe(false);
    }
  );

  it.each([
    { mode: "wrong-image-id" as const, message: /image/ },
    { mode: "wrong-network-id" as const, message: /network/ },
    { mode: "wrong-volume-mount" as const, message: /volume|mount/ }
  ])("rejects $mode before starting or executing in the container", async ({ mode, message }) => {
    // Given
    const root = await stateRoot();
    await claimTestGiteaService(root);
    const runner = new RecoveryRunner(mode);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    // When
    const recovery = ensureGitea(runner, hostLifecycleOptions(root));

    // Then
    await expect(recovery).rejects.toThrow(message);
    expect(runner.calls.some((call) => ["run", "start", "restart", "exec"].includes(call[1] ?? ""))).toBe(false);
  });

  it("retains the endpoint lease across an interrupted reconciliation retry", async () => {
    // Given
    const root = await stateRoot();
    const { endpointAddress: _endpointAddress, ...withoutEndpoint } = TEST_GITEA_SERVICE;
    await new LifecycleState(root).claimGiteaService({ ...withoutEndpoint, phase: "creating" });
    const runner = new RecoveryRunner("owned-running");
    runner.failCredentials = true;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    // When / Then
    await expect(ensureGitea(runner, hostLifecycleOptions(root))).rejects.toThrow(/injected credential interruption/);
    await expect(new LifecycleState(root).readGiteaService()).resolves.toMatchObject({
      phase: "error",
      endpointAddress: TEST_GITEA_SERVICE.endpointAddress
    });

    runner.failCredentials = false;
    await expect(ensureGitea(runner, hostLifecycleOptions(root))).resolves.toMatchObject({
      kind: "managed",
      endpointAddress: TEST_GITEA_SERVICE.endpointAddress
    });
  });
});

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-gitea-recovery-"));
  cleanup.push(root);
  return root;
}
