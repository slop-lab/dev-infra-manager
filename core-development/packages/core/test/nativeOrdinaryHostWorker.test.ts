import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeOrdinaryHostClient } from "../../../../core/packages/core/src/nativeOrdinaryHostClient.js";
import { serveNativeOrdinaryHostCapacity } from "../../../../core/packages/core/src/nativeOrdinaryHostWorker.js";
import { execution, ExecutorRunner } from "./nativeOrdinaryExecutorFixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native ordinary host capacity worker", () => {
  it("recovers and stops before another claim when the exact repository credential is absent", async () => {
    // Given
    const client = new WorkerClient();
    const recover = vi.spyOn(client, "recoverClaim");

    // When
    const served = serveNativeOrdinaryHostCapacity({
      client,
      runner: new ExecutorRunner(),
      gitExecutable: "/usr/bin/git",
      nativeGitEndpoint: "http://native-git:8080",
      journalPath: await temporaryJournal(),
      resolveReaderCredential: async () => undefined,
      randomId: ids()
    }, new AbortController().signal);

    // Then
    await expect(served).rejects.toThrow(/credential mapping/);
    expect(client.claimRequests).toHaveLength(1);
    expect(recover).toHaveBeenCalledOnce();
    expect(client.resultRequests).toHaveLength(0);
  });

  it("quiesces an idle capacity without issuing another claim", async () => {
    // Given
    const controller = new AbortController();
    const client = new WorkerClient(null);
    client.afterClaim = () => controller.abort();

    // When
    await serveNativeOrdinaryHostCapacity({
      client,
      runner: new ExecutorRunner(),
      gitExecutable: "/usr/bin/git",
      nativeGitEndpoint: "http://native-git:8080",
      journalPath: await temporaryJournal(),
      resolveReaderCredential: async () => undefined,
      idleDelayMilliseconds: 1,
      randomId: ids()
    }, controller.signal);

    // Then
    expect(client.attestations).toBe(1);
    expect(client.claimRequests).toHaveLength(1);
  });
});

class WorkerClient implements NativeOrdinaryHostClient {
  readonly hostId = "host-a";
  readonly capacity = "primary";
  readonly claimRequests: string[] = [];
  readonly resultRequests: unknown[] = [];
  attestations = 0;
  afterClaim: (() => void) | undefined;
  readonly #claim: ReturnType<typeof execution>["claim"] | undefined;

  constructor(claim: ReturnType<typeof execution>["claim"] | null = execution().claim) {
    this.#claim = claim ?? undefined;
  }

  async attest(): Promise<void> { this.attestations += 1; }

  prepareClaim(requestId: string) {
    return { requestId, body: JSON.stringify({ schemaVersion: 1, requestId, hostId: this.hostId, capacity: this.capacity }) };
  }

  async claim(request: ReturnType<WorkerClient["prepareClaim"]>) {
    this.claimRequests.push(request.requestId);
    this.afterClaim?.();
    return this.#claim === undefined ? undefined : { ...this.#claim, requestId: request.requestId };
  }

  async renewClaim(request: Parameters<NativeOrdinaryHostClient["renewClaim"]>[0]) {
    return {
      schemaVersion: 1, serviceId: "ordinary-main", requestId: request.requestId, claimId: request.claimId,
      leaseExpiresAt: Date.now() + 60_000, leaseDurationMilliseconds: 60_000
    } as const;
  }

  prepareRecovery(request: Parameters<NativeOrdinaryHostClient["prepareRecovery"]>[0]) {
    return { requestId: request.requestId, body: JSON.stringify(request) };
  }

  async recoverClaim(_request: Parameters<NativeOrdinaryHostClient["recoverClaim"]>[0]): Promise<void> {}

  prepareResult(request: Parameters<NativeOrdinaryHostClient["prepareResult"]>[0]) {
    return { requestId: request.requestId, body: JSON.stringify(request) };
  }

  async reportResult(request: Parameters<NativeOrdinaryHostClient["reportResult"]>[0]): Promise<void> {
    this.resultRequests.push(request);
  }
}

async function temporaryJournal(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-worker-test-"));
  roots.push(root);
  return join(root, "primary.json");
}

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `90000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  };
}
