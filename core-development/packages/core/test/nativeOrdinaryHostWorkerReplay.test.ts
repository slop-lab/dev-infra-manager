import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  NativeOrdinaryHostRequestRejectedError,
  type NativeOrdinaryHostClient
} from "../../../../core/packages/core/src/nativeOrdinaryHostClient.js";
import { NativeOrdinaryHostJournal } from "../../../../core/packages/core/src/nativeOrdinaryHostJournal.js";
import { serveNativeOrdinaryHostCapacity } from "../../../../core/packages/core/src/nativeOrdinaryHostWorker.js";
import { nativeContainerArgs } from "../../../../core/packages/core/src/nativeOrdinaryExecutorDocker.js";
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
    const claim = execution().claim;
    const runner = new ExecutorRunner();
    await armOwnedContainer(runner, claim);
    let workRootPath = "";
    const client = new ResultReplayClient(async () => {
      await expect(lstat(workRootPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(runner.calls.at(-1)?.args.slice(0, 3)).toEqual(["container", "rm", "--force"]);
      controller.abort();
    });
    const request = client.prepareResult(resultRequest(claim));
    const journal = new NativeOrdinaryHostJournal(journalPath);
    const privateRoot = { schemaVersion: 1, state: "planned", rootId: randomUUID() } as const;
    await journal.save({ kind: "result", claim, request, privateRoot });
    const workRoot = journal.privateRoot(privateRoot);
    workRootPath = await workRoot.create(claim.claimId);
    await writeFile(join(workRootPath, "candidate-data"), "untrusted\n");

    // When
    await run(client, journalPath, controller.signal, ids(), runner);

    // Then
    expect(client.resultBodies).toEqual([request.body]);
    expect(client.claimRequests).toHaveLength(0);
    expect(runner.calls[0]?.args.slice(0, 2)).toEqual(["container", "inspect"]);
    await expect(lstat(workRootPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "before-staging-marker",
    "partial-staging-marker",
    "after-marker-sync",
    "after-rename",
    "after-created-journal"
  ] as const)("cleans the exact owned root before recovery after %s crash", async (checkpoint) => {
    // Given
    const journalPath = await temporaryJournal();
    const journal = new NativeOrdinaryHostJournal(journalPath);
    const workRootPath = await crashDuringRootCreation(journalPath, checkpoint);
    const state = await journal.load();
    if (state?.kind !== "active") throw new Error("crashed worker did not leave an active journal");
    const claim = state.claim;
    const residueNames = (await readdir(join(journalPath, ".."))).filter((name) => name !== "primary.json");
    expect(residueNames).toHaveLength(1);
    const residueName = residueNames[0];
    if (residueName === undefined) throw new Error("crashed worker did not leave private root residue");
    const residue = await lstat(join(journalPath, "..", residueName), { bigint: true });
    expect(residue.mode & 0o777n).toBe(0o700n);
    expect(residueName.startsWith(".")).toBe(checkpoint !== "after-rename" && checkpoint !== "after-created-journal");
    if (state.privateRoot.state === "created") {
      expect({ device: residue.dev.toString(), inode: residue.ino.toString() }).toEqual({
        device: state.privateRoot.device,
        inode: state.privateRoot.inode
      });
    }
    const runner = new ExecutorRunner();
    await armOwnedContainer(runner, claim);
    const controller = new AbortController();
    const client = new RecoveryObservationClient(async () => {
      await expect(lstat(workRootPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(runner.calls.at(-1)?.args.slice(0, 3)).toEqual(["container", "rm", "--force"]);
      controller.abort();
    });

    // When
    await run(client, journalPath, controller.signal, ids(), runner);

    // Then
    expect(client.recoveries).toBe(1);
    expect(await readdir(join(journalPath, ".."))).toEqual([]);
  });

  it.each(["final", "staging"] as const)("withholds recovery for unverified %s residue", async (location) => {
    // Given
    const journalPath = await temporaryJournal();
    const journal = new NativeOrdinaryHostJournal(journalPath);
    const claim = execution().claim;
    const privateRoot = { schemaVersion: 1, state: "planned", rootId: randomUUID() } as const;
    await journal.save({ kind: "active", claim, privateRoot });
    const root = journal.privateRoot(privateRoot);
    const workRootPath = location === "final" ? root.path : root.stagingPath;
    await (await import("node:fs/promises")).mkdir(workRootPath, { mode: 0o700 });
    if (location === "staging") await writeFile(join(workRootPath, "foreign"), "retain\n");
    const client = new RecoveryObservationClient(async () => {});

    // When / Then
    await expect(run(client, journalPath, new AbortController().signal, ids()))
      .rejects.toThrow(/cleanup failed/);
    expect(client.recoveries).toBe(0);
    expect((await lstat(workRootPath)).isDirectory()).toBe(true);
  });

  it("retains a durable result instead of transforming a service-unavailable response into recovery", async () => {
    // Given
    const journalPath = await temporaryJournal();
    const client = new UnavailableResultClient();
    const claim = execution().claim;
    const request = client.prepareResult(resultRequest(claim));
    const journal = new NativeOrdinaryHostJournal(journalPath);
    const privateRoot = { schemaVersion: 1, state: "planned", rootId: randomUUID() } as const;
    await journal.save({ kind: "result", claim, privateRoot, request });

    // When / Then
    await expect(run(client, journalPath, new AbortController().signal, ids()))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(await journal.load()).toEqual({ kind: "result", claim, privateRoot, request });
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
  constructor(readonly afterResult: () => void | Promise<void>) { super(); }
  override async reportResult(request: Parameters<NativeOrdinaryHostClient["reportResult"]>[0]): Promise<void> {
    this.resultBodies.push(request.body);
    await this.afterResult();
  }
}

class RecoveryObservationClient extends WorkerClient {
  recoveries = 0;
  constructor(readonly afterRecovery: () => void | Promise<void>) { super(); }
  override async recoverClaim(_request: Parameters<NativeOrdinaryHostClient["recoverClaim"]>[0]): Promise<void> {
    this.recoveries += 1;
    await this.afterRecovery();
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

async function armOwnedContainer(runner: ExecutorRunner, claim: ReturnType<typeof execution>["claim"]): Promise<void> {
  await runner.run("docker", nativeContainerArgs(claim, {
    workspace: "/unused/workspace",
    script: "/unused/script",
    launcher: "/unused/runner",
    daemonConfig: "/unused/daemon"
  }));
  runner.calls.splice(0);
}

async function crashDuringRootCreation(journalPath: string, checkpoint: string): Promise<string> {
  const fixture = fileURLToPath(new URL("./nativeOrdinaryHostWorkerRootCrashFixture.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", fixture, journalPath, checkpoint], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  try {
    const [output] = await once(child.stdout, "data");
    return String(output).trim();
  } finally {
    child.kill("SIGKILL");
    const [_code, signal] = await once(child, "close");
    if (signal !== "SIGKILL") throw new Error(`worker fixture exited without SIGKILL: ${String(signal)}`);
  }
}
