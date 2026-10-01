import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureGiteaWebhookAllowedHosts,
  ensureGitea
} from "../../../../core/packages/core/src/gitea.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import {
  ConcurrentGiteaRunner,
  type GiteaRuntimeState
} from "./giteaReconciliationFixture.js";
import { hostLifecycleOptions } from "./hostLifecycleFixture.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => ({ address: "127.0.0.1", family: 4 }))
}));

async function allowPendingLifecycleWork(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("managed Gitea reconciliation concurrency", () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "dim-gitea-concurrency-"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("serializes simultaneous empty-state first use across all mutations and publication", async () => {
    // Given
    const runtime: GiteaRuntimeState = {
      network: false,
      volume: false,
      containerId: undefined,
      credentials: false
    };
    const runner = new ConcurrentGiteaRunner(runtime, "network-create");
    const options = hostLifecycleOptions(stateRoot);
    const first = ensureGitea(runner, options);
    await runner.firstMutationEntered.wait;

    // When
    const second = ensureGitea(runner, options);
    await allowPendingLifecycleWork();
    const interleavedCalls = [...runner.interleavedCalls];
    runner.releaseFirstMutation.open();
    const outcomes = await Promise.allSettled([first, second]);

    // Then
    expect(interleavedCalls).toEqual([]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(runner.mutations).toEqual([
      "network-create",
      "volume-create",
      "container-create",
      "user-create",
      "user-create",
      "user-create",
      "credential-store"
    ]);
    await expect(new LifecycleState(stateRoot).readGiteaService()).resolves.toMatchObject({ phase: "ready" });
  });

  it("holds one service transaction across webhook configuration and concurrent ensure", async () => {
    // Given
    const runtime: GiteaRuntimeState = {
      network: true,
      volume: true,
      containerId: "configured-gitea-id",
      credentials: true
    };
    const runner = new ConcurrentGiteaRunner(runtime, "webhook-edit");
    const options = hostLifecycleOptions(stateRoot);
    const configuration = configureGiteaWebhookAllowedHosts(runner, options, ["ci-target"]);
    await runner.firstMutationEntered.wait;

    // When
    const reconciliation = ensureGitea(runner, options);
    await allowPendingLifecycleWork();
    const interleavedCalls = [...runner.interleavedCalls];
    runner.releaseFirstMutation.open();
    const outcomes = await Promise.allSettled([configuration, reconciliation]);

    // Then
    expect(interleavedCalls).toEqual([]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(runner.mutations).toEqual(["webhook-edit", "restart:configured-gitea-id"]);
    await expect(new LifecycleState(stateRoot).readGiteaService()).resolves.toMatchObject({ phase: "ready" });
  });

  it("publishes a failed transaction before a waiter retries and publishes ready", async () => {
    // Given
    const runtime: GiteaRuntimeState = {
      network: false,
      volume: false,
      containerId: undefined,
      credentials: false
    };
    const runner = new ConcurrentGiteaRunner(runtime, "network-create");
    runner.failBlockedOperation = true;
    const options = hostLifecycleOptions(stateRoot);
    const first = ensureGitea(runner, options);
    await runner.firstMutationEntered.wait;
    const second = ensureGitea(runner, options);

    // When
    await allowPendingLifecycleWork();
    runner.releaseFirstMutation.open();
    const outcomes = await Promise.allSettled([first, second]);

    // Then
    expect(outcomes[0]?.status).toBe("rejected");
    expect(outcomes[1]?.status).toBe("fulfilled");
    expect(runner.interleavedCalls).toEqual([]);
    await expect(new LifecycleState(stateRoot).readGiteaService()).resolves.toMatchObject({ phase: "ready" });
  });
});
