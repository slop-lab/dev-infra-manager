import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { object, parseTaskReceipt, parseTaskRequest, taskReceipt, uuidPattern, type TaskLookup, type TaskReceipt, type TaskRequest } from "./taskContract.ts";

export type TaskJournal = { readonly mark: (phase: "create" | "message", sessionId?: string) => Promise<void>; readonly created: (sessionId: string) => Promise<void> };
function root(home: string, input: TaskLookup) { if (!isAbsolute(home) || resolve(home) !== home || !uuidPattern.test(input.workspaceId) || !uuidPattern.test(input.requestId)) throw Error("Invalid task journal identity"); return join(home, ".local/state/dim-agent-tools/tasks", input.workspaceId, input.requestId); }
export async function readPrivateTaskJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 16384) throw Error("Unsafe task record");
    const buffer = Buffer.alloc(16385), read = await handle.read(buffer, 0, buffer.length, 0), after = await handle.stat();
    if (read.bytesRead > 16384 || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw Error("Changing task record");
    const value: unknown = JSON.parse(buffer.toString("utf8", 0, read.bytesRead)); return value;
  } finally { await handle.close(); }
}
async function syncDirectory(path: string) { const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } }
async function directory(path: string, create: boolean): Promise<void> {
  const parent = dirname(path); if (parent !== path) await directory(parent, false);
  if (create) { try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (!code(error, "EEXIST")) throw error; } }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error("Unsafe task directory");
  if (create) await syncDirectory(parent);
}
async function ensureRoot(home: string, input: TaskLookup) {
  let current = home; await directory(home, false);
  for (const part of [".local", "state", "dim-agent-tools", "tasks", input.workspaceId]) {
    current = join(current, part); await directory(current, true);
    const info = await lstat(current); if (info.uid !== process.getuid?.() || part === "tasks" && (info.mode & 0o777) !== 0o700 || part === input.workspaceId && (info.mode & 0o777) !== 0o700) throw Error("Task journal must be private and owned");
  }
}
async function publish(file: string, value: unknown): Promise<void> {
  const temporary = join(dirname(file), `.pending-${randomUUID()}`), handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  try { await link(temporary, file); } finally { await unlink(temporary); }
  await syncDirectory(dirname(file));
}
export async function lookupTask(home: string, input: TaskLookup): Promise<TaskReceipt> {
  const path = root(home, input);
  try { await directory(path, false); } catch (error) { if (code(error, "ENOENT")) return taskReceipt(input, { outcome: "not-found", reason: "not-found" }); return taskReceipt(input); }
  let initial: TaskReceipt;
  try { initial = (await readClaim(path, input)).receipt; } catch { return taskReceipt(input); }
  let receipt = initial, created = false, creating = false, messaging = false;
  for (const name of ["session-created", "create-dispatching", "message-dispatching"] as const) {
    try {
      const marker = object(await readPrivateTaskJson(join(path, `${name}.json`)));
      switch (name) {
        case "session-created": if (initial.sessionId !== null) return initial; receipt = parseTaskReceipt({ ...receipt, sessionId: marker.sessionId }); created = true; break;
        case "create-dispatching": if (initial.sessionId !== null || marker.phase !== "create" || marker.sessionId !== null || marker.messageId !== initial.messageId) return initial; receipt = { ...receipt, phase: "create" }; creating = true; break;
        case "message-dispatching": if (marker.phase !== "message" || marker.sessionId !== receipt.sessionId || receipt.sessionId === null || marker.messageId !== initial.messageId) return initial; receipt = { ...receipt, phase: "message" }; messaging = true; break;
      }
    } catch (error) { if (!code(error, "ENOENT")) return initial; }
  }
  if (created && !creating || messaging && initial.sessionId === null && !created) return initial;
  try {
    const result = parseTaskReceipt(await readPrivateTaskJson(join(path, "result.json")));
    if (result.workspaceId !== input.workspaceId || result.requestId !== input.requestId || result.runtime !== initial.runtime) return initial;
    if (result.outcome === "accepted" || result.outcome === "outcome-unknown") {
      if (result.serverIdentity !== initial.serverIdentity || result.messageId !== initial.messageId || result.sessionId !== receipt.sessionId
        || (result.outcome === "accepted" ? !messaging : result.phase !== receipt.phase)) return initial;
    } else if (creating || messaging || created) return initial;
    await syncDirectory(path); return result;
  } catch { return receipt; }
}
async function readClaim(path: string, input: TaskLookup) {
  const claim = object(await readPrivateTaskJson(join(path, "claim.json"))), receipt = parseTaskReceipt(claim.receipt);
  if (claim.workspaceId !== input.workspaceId || claim.requestId !== input.requestId || typeof claim.digest !== "string" || !/^[a-f0-9]{64}$/.test(claim.digest)
    || receipt.workspaceId !== input.workspaceId || receipt.requestId !== input.requestId || receipt.outcome !== "outcome-unknown" || receipt.phase !== "claim" || receipt.reason !== "guarded" || receipt.serverIdentity === null || receipt.messageId === null) throw Error("Invalid guarded task claim");
  return { digest: claim.digest, receipt };
}
export async function runTaskRequest(home: string, input: TaskRequest, deliver: (journal: TaskJournal) => Promise<TaskReceipt>): Promise<TaskReceipt> {
  const path = root(home, input), digest = createHash("sha256").update("DIM task request v1\0").update(JSON.stringify(parseTaskRequest(input))).digest("hex");
  await ensureRoot(home, input);
  try { await mkdir(path, { mode: 0o700 }); await syncDirectory(dirname(path)); }
  catch (error) {
    if (!code(error, "EEXIST")) throw error;
    try { await directory(path, false); const claim = await readClaim(path, input); if (claim.digest !== digest) return taskReceipt(input, { runtime: input.runtime, outcome: "conflict", reason: "content-conflict" }); } catch { return taskReceipt(input); }
    return lookupTask(home, input);
  }
  const receipt = taskReceipt(input, { runtime: input.runtime, serverIdentity: input.serverIdentity, messageId: `msg_${input.requestId.replaceAll("-", "")}`, sessionId: input.target.kind === "session" ? input.target.sessionId : null });
  await publish(join(path, "claim.json"), { workspaceId: input.workspaceId, requestId: input.requestId, digest, receipt });
  const journal: TaskJournal = {
    async mark(phase, sessionId) { await publish(join(path, `${phase}-dispatching.json`), { phase, sessionId: sessionId ?? null, messageId: receipt.messageId }); },
    async created(sessionId) { await publish(join(path, "session-created.json"), { sessionId }); }
  };
  let result: TaskReceipt;
  try { result = parseTaskReceipt(await deliver(journal)); }
  catch { result = await lookupTask(home, input); }
  try { await publish(join(path, "result.json"), result); } catch { return lookupTask(home, input); }
  return lookupTask(home, input);
}
export function taskJournal(home: string, input: TaskLookup): TaskJournal {
  const path = root(home, input);
  return { async mark(phase, sessionId) { await publish(join(path, `${phase}-dispatching.json`), { phase, sessionId: sessionId ?? null, messageId: `msg_${input.requestId.replaceAll("-", "")}` }); }, async created(sessionId) { await publish(join(path, "session-created.json"), { sessionId }); } };
}
function code(error: unknown, expected: string) { return error instanceof Error && "code" in error && error.code === expected; }
