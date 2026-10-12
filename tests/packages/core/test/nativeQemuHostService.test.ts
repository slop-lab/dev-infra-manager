import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeNativeQemuHostAssignment } from "../../../../core/packages/core/src/nativeQemuHostService.js";
import { claimNativeQemuHostAssignment } from "../../../../core/packages/core/src/nativeQemuHostService.js";
import { replayNativeQemuHostJournal } from "../../../../core/packages/core/src/nativeQemuHostService.js";
import { NativeQemuHostJournal } from "../../../../core/packages/core/src/nativeQemuHostJournal.js";
import type { NativeQemuHostAssignment } from "../../../../core/packages/core/src/nativeQemuHostClient.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { qemuAssignment as assignment, qemuAuthority } from "./nativeQemuHostFixture.js";

const claimId = "00000000-0000-4000-8000-000000000001";
const capacity = { capacity: "kvm-a", runnerBaseImage: `runner@sha256:${"3".repeat(64)}`,
  jobBaseImage: `job@sha256:${"4".repeat(64)}`, supervisorMemoryBytes: "2097152",
  bounds: { cpu: "2", memoryBytes: "1024", pids: "64",
    wallClockSeconds: "60", outputBytes: "1024" } };

describe("native QEMU host claim lifecycle", () => {
  it("reuses the durable request ID after a claim response is lost", async () => {
    // Given
    const stateDirectory = await mkdtemp(join(tmpdir(), "native-qemu-service-"));
    const path = join(stateDirectory, "journal.json");
    const journal = new NativeQemuHostJournal(path);
    const requestIds: string[] = [];
    let loseResponse = true;
    const client = { async claim(requestId: string) {
      requestIds.push(requestId);
      if (loseResponse) { loseResponse = false; throw new LostAcknowledgementError(); }
      return { ...assignment, claim: { ...assignment.claim, requestId } };
    }, async renew() {}, async report() {} };

    // When
    await expect(claimNativeQemuHostAssignment(client, journal, AbortSignal.timeout(1_000)))
      .rejects.toBeInstanceOf(LostAcknowledgementError);
    const replayed = await claimNativeQemuHostAssignment(client, new NativeQemuHostJournal(path),
      AbortSignal.timeout(1_000));

    // Then
    expect(requestIds).toHaveLength(2);
    expect(requestIds[1]).toBe(requestIds[0]);
    expect(replayed?.claim.requestId).toBe(requestIds[0]);
    expect(await journal.load()).toEqual({ kind: "active", assignment: replayed });
  });

  it("renews during execution and reports only after cleanup", async () => {
    // Given
    const calls: string[] = [];
    const client = { async renew() { calls.push("renew"); }, async report() { calls.push("report"); } };
    const runner = new LifecycleRunner(calls, 20);

    // When
    await executeNativeQemuHostAssignment({ client, runner, capacity, assignment,
      stateDirectory: await mkdtemp(join(tmpdir(), "native-qemu-service-")), signal: AbortSignal.timeout(1_000),
      renewalIntervalMilliseconds: 1, createReadAuthority: async () => qemuAuthority() });

    // Then
    expect(calls).toContain("renew");
    expect(calls.indexOf("cleanup")).toBeLessThan(calls.indexOf("report"));
  });

  it("aborts execution, cleans ownership, and withholds a result when renewal fails", async () => {
    // Given
    const calls: string[] = [];
    const client = { async renew() { calls.push("renew"); throw new RenewalError(); },
      async report() { calls.push("report"); } };
    const runner = new LifecycleRunner(calls);

    // When
    const operation = executeNativeQemuHostAssignment({ client, runner, capacity, assignment,
      stateDirectory: await mkdtemp(join(tmpdir(), "native-qemu-service-")), signal: AbortSignal.timeout(1_000),
      renewalIntervalMilliseconds: 1, createReadAuthority: async () => qemuAuthority() });

    // Then
    await expect(operation).rejects.toBeInstanceOf(RenewalError);
    expect(calls).toContain("cleanup");
    expect(calls).not.toContain("report");
  });

  it("replays an exact durable result after report acknowledgement is lost", async () => {
    // Given
    const calls: string[] = [];
    const stateDirectory = await mkdtemp(join(tmpdir(), "native-qemu-service-"));
    const journal = new NativeQemuHostJournal(join(stateDirectory, "journal.json"));
    const firstClient = { async renew() {}, async report() { throw new LostAcknowledgementError(); } };

    // When
    await expect(executeNativeQemuHostAssignment({ client: firstClient, runner: new LifecycleRunner(calls, 1),
      capacity, assignment, stateDirectory, journal, signal: AbortSignal.timeout(1_000),
      renewalIntervalMilliseconds: 50, createReadAuthority: async () => qemuAuthority() }))
      .rejects.toBeInstanceOf(LostAcknowledgementError);
    const replayClient = { async renew() {}, async report(id: string) { calls.push(`report:${id}`); },
      async recover() { calls.push("recover"); } };
    await replayNativeQemuHostJournal(replayClient, new LifecycleRunner(calls, 1), stateDirectory, journal);

    // Then
    expect(calls).toContain(`report:${claimId}`);
    expect(calls).not.toContain("recover");
    expect(await journal.load()).toBeUndefined();
  });
});

class RenewalError extends Error { readonly name = "RenewalError"; }
class LostAcknowledgementError extends Error { readonly name = "LostAcknowledgementError"; }
class LifecycleRunner implements StreamingCommandRunner {
  constructor(private readonly calls: string[], private readonly completionMilliseconds?: number) {}
  run(command: string, args: string[]): Promise<CommandResult> {
    if (args[1] === "ls") this.calls.push("cleanup");
    return Promise.resolve({ command, args, stdout: "", stderr: "", exitCode: 0 });
  }
  runStreaming(_command: string, _args: string[], options?: RunOptions): Promise<number> {
    this.calls.push("execute");
    return new Promise((resolve, reject) => {
      const timer = this.completionMilliseconds === undefined ? undefined
        : setTimeout(() => resolve(0), this.completionMilliseconds);
      options?.signal?.addEventListener("abort", () => {
        if (timer !== undefined) clearTimeout(timer);
        reject(options.signal?.reason);
      }, { once: true });
    });
  }
}
