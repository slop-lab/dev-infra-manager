import { verifyAndMaterializeCandidate } from "./candidate.js";
import { executionCandidateCredential } from "./candidateLease.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { tryAcquireKernelGuard, type StreamingCommandRunner } from "@slop-lab/dim-host-core";
import { withNativeGitExecutionReadAuthority } from "./nativeGitCandidateReadAuthority.js";
import { NativeHostPrivateRoot, type NativeHostPrivateRootIdentity } from "./private-root.js";
import { executionResultSchema } from "@slop-lab/dim-contracts-ci/aggregate";
import { taskResultSchema, type TaskAssignment, type TaskResult } from "@slop-lab/dim-contracts-execution";
import type { ExecutionTaskHandler } from "@slop-lab/dim-contracts-execution/plugin-api";
import { ExecutionServiceUnavailableError, isTaskAssignment, parseAssignment, type ExecutionWorkerClient, type WorkerAssignment, type WorkerResult } from "./client.js";
import type { ExecutionBackend } from "./backend.js";

type Journal = { requestId: string; assignment?: WorkerAssignment;
  root?: NativeHostPrivateRootIdentity; result?: WorkerResult };
export type ExecutionWorkerOptions = { readonly directory: string; readonly client: ExecutionWorkerClient;
  readonly backend?: ExecutionBackend; readonly runner?: StreamingCommandRunner;
  readonly taskHandlers?: readonly ExecutionTaskHandler[];
  readonly gitEndpoint?: string; readonly gitExecutable?: string; readonly signal: AbortSignal };
/** One host-selected slot, one durable request and owned resource at a time. */
export async function runExecutionWorker(options: ExecutionWorkerOptions): Promise<void> {
  await privateDirectory(options.directory);
  const guard = await tryAcquireKernelGuard(join(options.directory, "worker.guard"));
  if (guard === undefined) throw new Error("execution worker slot is already running");
  const journalPath = join(options.directory, "execution.json");
  try {
    while (!options.signal.aborted) {
      let journal = await readJournal(journalPath);
      if (journal !== undefined) {
        if (journal.assignment === undefined) {
          const assignment = await claim(journal.requestId);
          if (assignment === undefined) { await clear(); continue; }
          journal = { ...journal, assignment }; await writeJournal(journalPath, journal);
        }
        // A process restart never resumes candidate code. Reap only resources owned by its journal.
        await recover(journal);
      } else {
        journal = { requestId: randomUUID() };
        await writeJournal(journalPath, journal);
        const assignment = await claim(journal.requestId);
        if (assignment === undefined) { await clear(); await pause(); continue; }
        journal = { ...journal, assignment };
        await writeJournal(journalPath, journal);
        if (assignment.phase !== "assigned" || assignment.grant === undefined) { await recover(journal); continue; }
        await execute(journal);
      }
    }
  } finally { await guard.release(); }

  async function execute(journal: Journal): Promise<void> {
    const assignment = journal.assignment!;
    assertBackend(assignment);
    if (isTaskAssignment(assignment)) { await executeTask(journal, assignment); return; }
    const grant = assignment.grant!;
    const backend = options.backend!;
    const runner = options.runner;
    if (options.gitEndpoint === undefined || options.gitExecutable === undefined || runner === undefined) throw new Error("execution worker requires Native Git and runner configuration");
    journal.root = { schemaVersion: 1, state: "planned", rootId: randomUUID() };
    await writeJournal(journalPath, journal);
    const root = new NativeHostPrivateRoot(options.directory, journal.root);
    await root.create(assignment.id);
    journal.root = root.identity; await writeJournal(journalPath, journal);
    const result = await withLease(assignment, async (signal) => {
      const credentialProvider = executionCandidateCredential((signal) => options.client.candidate(assignment, signal));
      const credential = await credentialProvider(signal);
      return backend.run({ grant, root: root.path, runner, signal,
        acquireCandidate: async (paths) => withNativeGitExecutionReadAuthority({ gitExecutable: options.gitExecutable!,
          serviceEndpoint: options.gitEndpoint!, temporaryRoot: root.path,
          credential: { username: credential.username, password: credential.password }, credentialProvider, descriptor: grant.descriptor },
        paths.signal, (authority) => verifyAndMaterializeCandidate({ ...paths, authority,
          descriptor: grant.descriptor, descriptorDigest: grant.descriptorDigest })) });
    });
    if (!await root.cleanup(assignment.id)) throw new Error("CI private root cleanup is uncertain; slot remains fenced");
    journal.result = result;
    await writeJournal(journalPath, journal);
    await retry(() => options.client.report(assignment, result, options.signal));
    await clear();
  }
  async function executeTask(journal: Journal, assignment: TaskAssignment): Promise<void> {
    const handler = taskHandler(assignment);
    const result = await withLease(assignment, async (signal): Promise<TaskResult> => {
      let outcome: { result: TaskResult["result"]; value?: unknown; error?: string };
      try {
        const value = await handler.run({ assignment, payload: assignment.event.payload,
          exchange: (operation, input, requestedSignal) => options.client.exchange(assignment, operation, input,
            requestedSignal === undefined ? signal : AbortSignal.any([signal, requestedSignal])), signal });
        signal.throwIfAborted();
        outcome = { result: "success", ...(value === undefined ? {} : { value }) };
      } catch (error) {
        outcome = { result: signal.aborted ? "cancelled" : "failure", error: (error instanceof Error ? error.message : String(error)).slice(0, 2048) };
      }
      if (!await handler.cleanup({ assignment })) throw new Error("task cleanup is uncertain; slot remains fenced");
      return taskResultSchema.parse({ executionId: assignment.id, descriptorDigest: assignment.grant!.descriptorDigest,
        cleanupComplete: true, ...outcome });
    });
    journal.result = result;
    await writeJournal(journalPath, journal);
    await retry(() => options.client.report(assignment, result, options.signal));
    await clear();
  }
  async function withLease<T>(assignment: WorkerAssignment, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const leaseLost = new AbortController(), stopRenewing = new AbortController();
    const signal = AbortSignal.any([options.signal, leaseLost.signal]);
    const leaseMilliseconds = await options.client.renew(assignment, signal);
    const renewals = (async () => {
      while (!stopRenewing.signal.aborted) {
        try {
          await delay(Math.max(10, Math.floor(leaseMilliseconds / 3)), undefined, { signal: stopRenewing.signal });
          await options.client.renew(assignment, signal);
        } catch { if (!stopRenewing.signal.aborted) leaseLost.abort(); return; }
      }
    })();
    try { return await operation(signal); }
    finally { stopRenewing.abort(); await renewals; }
  }
  async function recover(journal: Journal): Promise<void> {
    const assignment = journal.assignment!;
    assertBackend(assignment);
    if (journal.result !== undefined) {
      await retry(() => options.client.report(assignment, journal.result!, options.signal));
    } else {
      if (isTaskAssignment(assignment)) {
        if (!await taskHandler(assignment).cleanup({ assignment })) throw new Error("task cleanup is uncertain; slot remains fenced");
      } else if (assignment.grant !== undefined && !await options.backend!.cleanup(options.runner!, assignment.grant,
        journal.root === undefined ? options.directory : new NativeHostPrivateRoot(options.directory, journal.root).path)) {
        throw new Error("CI resource cleanup is uncertain; slot remains fenced");
      }
      if (journal.root !== undefined && !await new NativeHostPrivateRoot(options.directory, journal.root).cleanup(assignment.id)) {
        throw new Error("CI private root cleanup is uncertain; slot remains fenced");
      }
      await retry(() => options.client.recover(assignment, options.signal));
    }
    await clear();
  }
  function taskHandler(assignment: TaskAssignment): ExecutionTaskHandler {
    const handler = options.taskHandlers?.find((handler) => handler.taskType === assignment.event.taskType && handler.revision === assignment.event.handlerRevision);
    if (handler === undefined) throw new Error("task assignment requires an installed handler with the exact reviewed revision");
    return handler;
  }
  function assertBackend(assignment: WorkerAssignment): void {
    const grant = assignment.grant;
    if (isTaskAssignment(assignment)) {
      taskHandler(assignment);
      if (grant !== undefined && (grant.executionId !== assignment.id || grant.workerId !== assignment.workerId || grant.slotId !== assignment.slotId)) throw new Error("task assignment ownership conflicts");
      return;
    }
    if (grant !== undefined && (grant.event.executionKind !== options.backend?.kind || grant.executionId !== assignment.id
      || grant.workerId !== assignment.workerId || grant.slotId !== assignment.slotId)) {
      throw new Error("CI assignment does not match this worker backend");
    }
  }
  function claim(requestId: string) { return retry(() => options.client.claim(requestId, options.signal)); }
  async function retry<T>(operation: () => Promise<T>): Promise<T> {
    let backoff = 250;
    for (;;) {
      options.signal.throwIfAborted();
      try { return await operation(); }
      catch (error) {
        if (!(error instanceof ExecutionServiceUnavailableError)) throw error;
        await delay(backoff, undefined, { signal: options.signal });
        backoff = Math.min(5_000, backoff * 2);
      }
    }
  }
  async function clear() { await rm(journalPath, { force: true }); await syncDirectory(options.directory); }
  async function pause() { try { await delay(250, undefined, { signal: options.signal }); } catch { /* shutdown */ } }
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()
    || (metadata.mode & 0o077) !== 0) throw new Error("execution worker directory must be an owned private directory");
}
async function readJournal(path: string): Promise<Journal | undefined> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0 || metadata.size > 1024 * 1024) {
      throw new Error("execution worker journal is invalid");
    }
    const raw: unknown = JSON.parse(await handle.readFile("utf8"));
    const row = z.object({ requestId: z.string().uuid(), assignment: z.unknown().optional(),
      root: z.unknown().optional(), result: z.union([executionResultSchema, taskResultSchema]).optional() }).strict().parse(raw);
    return { requestId: row.requestId, ...(row.assignment === undefined ? {} : { assignment: parseAssignment(row.assignment) }),
      ...(row.root === undefined ? {} : { root: row.root as NativeHostPrivateRootIdentity }),
      ...(row.result === undefined ? {} : { result: row.result }) };
  } finally { await handle.close(); }
}
async function writeJournal(path: string, value: Journal): Promise<void> {
  const staging = `${path}.${randomUUID()}`;
  const handle = await open(staging, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(staging, path); await syncDirectory(join(path, ".."));
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}
