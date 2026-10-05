import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NativeOrdinaryHostRequestRejectedError,
  type NativeOrdinaryHostClient
} from "../../../../core/packages/core/src/nativeOrdinaryHostClient.js";
import { NativeOrdinaryHostJournal } from "../../../../core/packages/core/src/nativeOrdinaryHostJournal.js";
import { serveNativeOrdinaryHostCapacity } from "../../../../core/packages/core/src/nativeOrdinaryHostWorker.js";
import { execution, ExecutorRunner } from "./nativeOrdinaryExecutorFixture.js";
import { WorkerClient, ids, resultRequest } from "./nativeOrdinaryHostWorkerReplayFixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native ordinary host capacity journal replay", () => {
  it("replays the same claim request after its response is lost and the worker restarts", async () => {
    // Given
    const journalPath = await temporaryJournal();
    const client = new LostClaimResponseClient();

    // When
    await expect(run(client, journalPath, new AbortController().signal,
      () => "90000000-0000-4000-8000-000000000001")).rejects.toThrow("claim response lost");
    const restarted = new AbortController();
    client.afterReplay = () => restarted.abort();
    await run(client, journalPath, restarted.signal, () => "90000000-0000-4000-8000-000000000002");

    // Then
    expect(client.claimRequests).toEqual([
      "90000000-0000-4000-8000-000000000001",
      "90000000-0000-4000-8000-000000000001"
    ]);
  });

  it("replays the exact recovery bytes after cleanup acknowledgement is lost and the worker restarts", async () => {
    // Given
    const journalPath = await temporaryJournal();
    const client = new LostRecoveryResponseClient();

    // When
    await expect(run(client, journalPath, new AbortController().signal, ids())).rejects.toThrow(/recovery/);
    const restarted = new AbortController();
    client.afterRecoveryReplay = () => restarted.abort();
    await run(client, journalPath, restarted.signal, () => "90000000-0000-4000-8000-000000000099");

    // Then
    expect(client.recoveryBodies).toHaveLength(2);
    expect(client.recoveryBodies[1]).toBe(client.recoveryBodies[0]);
    expect(client.claimRequests).toHaveLength(1);
  });

  it("cleans owned resources before replaying exact durable result bytes after restart", async () => {
    // Given
    const journalPath = await temporaryJournal();
    const controller = new AbortController();
    const client = new ResultReplayClient(() => controller.abort());
    const claim = execution().claim;
    const request = client.prepareResult(resultRequest(claim));
    await new NativeOrdinaryHostJournal(journalPath).save({ kind: "result", claim, request });
    const runner = new ExecutorRunner();

    // When
    await run(client, journalPath, controller.signal, ids(), runner);

    // Then
    expect(client.resultBodies).toEqual([request.body]);
    expect(client.claimRequests).toHaveLength(0);
    expect(runner.calls[0]?.args.slice(0, 2)).toEqual(["container", "inspect"]);
  });

  it("retains a durable result instead of transforming a service-unavailable response into recovery", async () => {
    // Given
    const journalPath = await temporaryJournal();
    const client = new UnavailableResultClient();
    const claim = execution().claim;
    const request = client.prepareResult(resultRequest(claim));
    const journal = new NativeOrdinaryHostJournal(journalPath);
    await journal.save({ kind: "result", claim, request });

    // When / Then
    await expect(run(client, journalPath, new AbortController().signal, ids()))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(await journal.load()).toEqual({ kind: "result", claim, request });
    expect(client.recoveries).toBe(0);
  });
});

async function run(
  client: NativeOrdinaryHostClient,
  journalPath: string,
  signal: AbortSignal,
  randomId: () => string,
  runner = new ExecutorRunner()
): Promise<void> {
  await serveNativeOrdinaryHostCapacity({
    client, runner, gitExecutable: "/usr/bin/git", nativeGitEndpoint: "http://native-git:8080",
    journalPath, resolveReaderCredential: async () => undefined, randomId
  }, signal);
}

class LostClaimResponseClient extends WorkerClient {
  afterReplay: (() => void) | undefined;
  override async claim(request: ReturnType<WorkerClient["prepareClaim"]>) {
    this.claimRequests.push(request.requestId);
    if (this.claimRequests.length === 1) throw new Error("claim response lost");
    this.afterReplay?.();
    return undefined;
  }
}

class LostRecoveryResponseClient extends WorkerClient {
  readonly recoveryBodies: string[] = [];
  afterRecoveryReplay: (() => void) | undefined;
  override async recoverClaim(request: Parameters<NativeOrdinaryHostClient["recoverClaim"]>[0]): Promise<void> {
    this.recoveryBodies.push(request.body);
    if (this.recoveryBodies.length === 1) throw new Error("recovery response lost");
    this.afterRecoveryReplay?.();
  }
}

class ResultReplayClient extends WorkerClient {
  readonly resultBodies: string[] = [];
  constructor(readonly afterResult: () => void) { super(); }
  override async reportResult(request: Parameters<NativeOrdinaryHostClient["reportResult"]>[0]): Promise<void> {
    this.resultBodies.push(request.body);
    this.afterResult();
  }
}

class UnavailableResultClient extends WorkerClient {
  recoveries = 0;
  override async reportResult(): Promise<void> { throw new NativeOrdinaryHostRequestRejectedError(503); }
  override async recoverClaim(_request: Parameters<NativeOrdinaryHostClient["recoverClaim"]>[0]): Promise<void> {
    this.recoveries += 1;
  }
}

async function temporaryJournal(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-worker-replay-test-"));
  roots.push(root);
  return join(root, "primary.json");
}
