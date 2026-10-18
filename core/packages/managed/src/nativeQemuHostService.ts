import { setTimeout as delay } from "node:timers/promises";
import { createNativeGitCandidateReadAuthority } from "./nativeGitCandidateReadAuthority.js";
import { loadNativeQemuConnection } from "./nativeQemuConnection.js";
import { assertNativeQemuKvmAvailable, assertNativeQemuRunnerAvailable } from "./nativeQemuHostRuntime.js";
import { NativeQemuHostClient } from "./nativeQemuHostClient.js";
import type { NativeQemuHostAssignment } from "./nativeQemuHostClient.js";
import { cleanupNativeQemuAssignment, executeNativeQemuAssignment } from "./nativeQemuHostExecutor.js";
import { acquireNativeQemuHostCapacityGuards, NativeQemuHostJournal } from "./nativeQemuHostJournal.js";
import type { NativeQemuExecutionCapacity } from "./nativeQemuHostExecutor.js";
import { ProcessRunner } from "@slop-lab/dim-core";
import type { StreamingCommandRunner } from "@slop-lab/dim-core";

export async function runNativeQemuHost(hostId: string, connectionPath: string, signal: AbortSignal,
  runner: StreamingCommandRunner = new ProcessRunner()): Promise<void> {
  const connection = await loadNativeQemuConnection(connectionPath, hostId);
  await assertNativeQemuKvmAvailable(runner, signal);
  await Promise.all(connection.capacities.map((capacity) =>
    assertNativeQemuRunnerAvailable(runner, capacity.runnerBaseImage, capacity.jobBaseImage, signal)));
  const capacityInputs = connection.capacities.map((capacity) => ({ capacity,
    stateDirectory: `/var/lib/dim-native-qemu-host/${capacity.capacity}` }));
  const guards = await acquireNativeQemuHostCapacityGuards(
    capacityInputs.map(({ stateDirectory }) => `${stateDirectory}/journal.json`));
  const guardedCapacities = capacityInputs.map((input, index) => {
    const guard = guards[index];
    if (guard === undefined) throw new NativeQemuHostServiceError("native QEMU capacity guard is missing");
    return { ...input, guard };
  });
  const controller = new AbortController();
  const workerSignal = AbortSignal.any([signal, controller.signal]);
  const workers = guardedCapacities.map(async ({ capacity, stateDirectory, guard }) => {
    const client = new NativeQemuHostClient(connection, capacity.capacity);
    const journal = new NativeQemuHostJournal(`${stateDirectory}/journal.json`);
    try {
      await client.attest(workerSignal);
      while (!workerSignal.aborted) {
        const state = await journal.load();
        if (state?.kind === "active" || state?.kind === "result") {
          await replayNativeQemuHostJournal(client, runner, stateDirectory, journal);
          continue;
        }
        const assignment = await claimNativeQemuHostAssignment(client, journal, workerSignal);
        if (assignment === undefined) {
          try { await delay(1_000, undefined, { signal: workerSignal }); }
          catch (error) { if (workerSignal.aborted) return; throw error; }
          continue;
        }
        await executeNativeQemuHostAssignment({ client, runner, capacity: {
          capacity: capacity.capacity, runnerBaseImage: capacity.runnerBaseImage,
          jobBaseImage: capacity.jobBaseImage, supervisorMemoryBytes: String(capacity.supervisorMemoryBytes),
          bounds: { cpu: String(capacity.cpus),
            memoryBytes: String(capacity.memoryBytes), pids: String(capacity.pids),
            wallClockSeconds: String(capacity.timeoutSeconds), outputBytes: String(capacity.outputBytes) } },
          assignment, stateDirectory, journal, signal: workerSignal,
          createReadAuthority: async ({ assignment: selected, privateRoot, signal: readSignal }) => {
            const lease = await client.candidateLease(selected, readSignal);
            return createNativeGitCandidateReadAuthority({ gitExecutable: connection.gitExecutable,
              serviceEndpoint: connection.nativeGit.endpoint,
              credential: { username: lease.username, password: lease.password }, temporaryRoot: privateRoot,
              claim: { projectId: selected.attempt.descriptor.projectId,
                repositoryId: selected.attempt.descriptor.repositoryId,
                protectedRef: selected.attempt.descriptor.protectedRef,
                expectedProtectedHead: selected.attempt.descriptor.expectedProtectedHead,
                candidateCommit: selected.attempt.descriptor.candidateCommit,
                candidateTree: selected.attempt.descriptor.candidateTree } });
          } });
        await journal.clear();
      }
    } finally { await guard.release(); }
  });
  try { await Promise.all(workers); }
  catch (error) { controller.abort(); await Promise.allSettled(workers); throw error; }
}

type NativeQemuClaimClient = {
  readonly claim?: (requestId: string, signal: AbortSignal) => Promise<NativeQemuHostAssignment | undefined>;
  readonly renew: (claimId: string, signal: AbortSignal) => Promise<void>;
  readonly report: (claimId: string, terminalEvent: Readonly<Record<string, unknown>>,
    signal: AbortSignal) => Promise<void>;
  readonly recover?: (claimId: string, signal: AbortSignal) => Promise<void>;
};

export async function executeNativeQemuHostAssignment(input: {
  readonly client: NativeQemuClaimClient;
  readonly runner: StreamingCommandRunner;
  readonly capacity: NativeQemuExecutionCapacity;
  readonly assignment: NativeQemuHostAssignment;
  readonly stateDirectory: string;
  readonly signal: AbortSignal;
  readonly journal?: NativeQemuHostJournal;
  readonly renewalIntervalMilliseconds?: number;
  readonly createReadAuthority: import("./nativeQemuHostExecutor.js").NativeQemuReadAuthorityFactory;
}): Promise<void> {
  const claimId = input.assignment.claim.claimId;
  if (typeof claimId !== "string") throw new NativeQemuHostServiceError("native QEMU claim ID is invalid");
  const interval = input.renewalIntervalMilliseconds ?? 5_000;
  if (!Number.isSafeInteger(interval) || interval < 1) {
    throw new NativeQemuHostServiceError("native QEMU renewal interval is invalid");
  }
  const lifecycle = new AbortController();
  await input.journal?.save({ kind: "active", assignment: input.assignment });
  const executionSignal = AbortSignal.any([input.signal, lifecycle.signal]);
  let renewalFailure: { readonly error: unknown } | undefined;
  const renewal = renewClaim(input.client, claimId, interval, executionSignal).catch((error: unknown) => {
    renewalFailure = { error };
    lifecycle.abort(error);
  });
  let outcome;
  try {
    outcome = await executeNativeQemuAssignment({ runner: input.runner, capacity: input.capacity,
      assignment: input.assignment, stateDirectory: input.stateDirectory, signal: executionSignal,
      createReadAuthority: input.createReadAuthority });
  } catch (error) {
    lifecycle.abort();
    await renewal;
    if (renewalFailure !== undefined) throw renewalFailure.error;
    throw error;
  }
  lifecycle.abort();
  await renewal;
  if (renewalFailure !== undefined) throw renewalFailure.error;
  await input.journal?.save({ kind: "result", claimId, terminalEvent: outcome.terminalEvent });
  await input.client.report(claimId, outcome.terminalEvent, AbortSignal.timeout(30_000));
}

export async function replayNativeQemuHostJournal(client: NativeQemuClaimClient,
  runner: StreamingCommandRunner, stateDirectory: string, journal: NativeQemuHostJournal): Promise<void> {
  const state = await journal.load();
  if (state === undefined) return;
  if (state.kind === "claim") throw new NativeQemuHostServiceError("native QEMU claim replay requires the claim client");
  const claimId = state.kind === "active" ? claimIdFrom(state.assignment) : state.claimId;
  const cleaned = await cleanupNativeQemuAssignment(runner, claimId, `${stateDirectory}/${claimId}`);
  if (!cleaned) throw new NativeQemuHostServiceError("native QEMU replay cleanup is incomplete");
  if (state.kind === "result") {
    await client.report(claimId, state.terminalEvent, AbortSignal.timeout(30_000));
  } else {
    if (client.recover === undefined) throw new NativeQemuHostServiceError("native QEMU recovery client is unavailable");
    await client.recover(claimId, AbortSignal.timeout(30_000));
  }
  await journal.clear();
}

export async function claimNativeQemuHostAssignment(client: NativeQemuClaimClient,
  journal: NativeQemuHostJournal, signal: AbortSignal): Promise<NativeQemuHostAssignment | undefined> {
  if (client.claim === undefined) throw new NativeQemuHostServiceError("native QEMU claim client is unavailable");
  const state = await journal.load();
  if (state?.kind === "active" || state?.kind === "result") {
    throw new NativeQemuHostServiceError("native QEMU ownership must be replayed before claiming");
  }
  const requestId = state?.requestId ?? crypto.randomUUID();
  if (state === undefined) await journal.save({ kind: "claim", requestId });
  const assignment = await client.claim(requestId, signal);
  if (assignment === undefined) {
    await journal.clear();
    return undefined;
  }
  await journal.save({ kind: "active", assignment });
  const leaseExpiresAt = assignment.claim.leaseExpiresAt;
  if (typeof leaseExpiresAt !== "number" || !Number.isSafeInteger(leaseExpiresAt)) {
    throw new NativeQemuHostServiceError("native QEMU claim lease is invalid");
  }
  if (leaseExpiresAt <= Date.now()) return undefined;
  return assignment;
}

function claimIdFrom(assignment: NativeQemuHostAssignment): string {
  const claimId = assignment.claim.claimId;
  if (typeof claimId !== "string") throw new NativeQemuHostServiceError("native QEMU claim ID is invalid");
  return claimId;
}

async function renewClaim(client: NativeQemuClaimClient, claimId: string, interval: number,
  signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try { await delay(interval, undefined, { signal }); }
    catch (error) { if (signal.aborted) return; throw error; }
    if (signal.aborted) return;
    await client.renew(claimId, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
  }
}

export class NativeQemuHostServiceError extends Error { readonly name = "NativeQemuHostServiceError"; }
