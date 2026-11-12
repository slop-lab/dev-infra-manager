export type TaskTarget = { readonly kind: "new" } | { readonly kind: "session"; readonly sessionId: string };
export type TaskRequest = {
  readonly workspaceId: string; readonly requestId: string; readonly runtime: string; readonly serverIdentity: string;
  readonly target: TaskTarget; readonly text: string; readonly mode: "execute" | "record-only";
};
export type TaskLookup = { readonly workspaceId: string; readonly requestId: string };
export type TaskReceipt = TaskLookup & {
  readonly schemaVersion: 1; readonly runtime: string; readonly serverIdentity: string | null;
  readonly outcome: "accepted" | "outcome-unknown" | "rejected" | "conflict" | "not-found" | "unsupported";
  readonly phase: "claim" | "create" | "message" | "complete";
  readonly sessionId: string | null; readonly messageId: string | null;
  readonly reason: "accepted" | "guarded" | "content-conflict" | "not-found" | "unsupported-runtime" | "stale-server" | "adapter-unavailable" | "transport-unknown" | "invalid-session";
  readonly completion: "not-assessed";
};
export class TaskInputError extends Error { readonly name = "TaskInputError"; }
export const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const sessionPattern = /^ses_[A-Za-z0-9]{1,100}$/;
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaskInputError("Task input must be an object"); return Object.fromEntries(Object.entries(value)); }
export function exact(row: Record<string, unknown>, keys: readonly string[]): void { if (Object.keys(row).some(key => !keys.includes(key))) throw new TaskInputError("Unknown task input field"); }
export function parseTaskLookup(input: unknown): TaskLookup {
  const row = object(input); exact(row, ["workspaceId", "requestId"]);
  if (typeof row.workspaceId !== "string" || !uuidPattern.test(row.workspaceId) || typeof row.requestId !== "string" || !uuidPattern.test(row.requestId)) throw new TaskInputError("Invalid task workspace or request identity");
  return { workspaceId: row.workspaceId, requestId: row.requestId };
}
export function parseTaskRequest(input: unknown): TaskRequest {
  const row = object(input); exact(row, ["workspaceId", "requestId", "runtime", "serverIdentity", "target", "text", "mode"]);
  const identity = parseTaskLookup({ workspaceId: row.workspaceId, requestId: row.requestId }), target = object(row.target);
  if (typeof row.runtime !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(row.runtime) || typeof row.serverIdentity !== "string" || !/^[a-f0-9]{64}$/.test(row.serverIdentity)
    || typeof row.text !== "string" || row.text.trim().length === 0 || Buffer.byteLength(row.text) > 8192 || Buffer.from(row.text).toString("utf8") !== row.text
    || row.mode !== "execute" && row.mode !== "record-only" || Buffer.byteLength(JSON.stringify(row)) > 12_288) throw new TaskInputError("Invalid task runtime, server identity, text or delivery mode");
  let selected: TaskTarget;
  switch (target.kind) {
    case "new": exact(target, ["kind"]); selected = { kind: "new" }; break;
    case "session": exact(target, ["kind", "sessionId"]); if (typeof target.sessionId !== "string" || !sessionPattern.test(target.sessionId)) throw new TaskInputError("Invalid task session identity"); selected = { kind: "session", sessionId: target.sessionId }; break;
    default: throw new TaskInputError("Unsupported task target");
  }
  return { ...identity, runtime: row.runtime, serverIdentity: row.serverIdentity, target: selected, text: row.text, mode: row.mode };
}
export function taskReceipt(input: TaskLookup, change: Partial<Omit<TaskReceipt, keyof TaskLookup | "schemaVersion" | "completion">> = {}): TaskReceipt {
  return { workspaceId: input.workspaceId, requestId: input.requestId, schemaVersion: 1, runtime: "opencode", serverIdentity: null, outcome: "outcome-unknown", phase: "claim", sessionId: null, messageId: null, reason: "guarded", completion: "not-assessed", ...change };
}
export function parseTaskReceipt(value: unknown): TaskReceipt {
  const row = object(value), lookup = parseTaskLookup({ workspaceId: row.workspaceId, requestId: row.requestId });
  if (row.schemaVersion !== 1 || row.completion !== "not-assessed" || typeof row.runtime !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(row.runtime)
    || row.serverIdentity !== null && (typeof row.serverIdentity !== "string" || !/^[a-f0-9]{64}$/.test(row.serverIdentity))
    || row.sessionId !== null && (typeof row.sessionId !== "string" || !sessionPattern.test(row.sessionId))
    || row.messageId !== null && (typeof row.messageId !== "string" || !/^msg_[a-f0-9]{32}$/.test(row.messageId))) throw new TaskInputError("Invalid task receipt");
  const outcome = choice(row.outcome, ["accepted", "outcome-unknown", "rejected", "conflict", "not-found", "unsupported"]), phase = choice(row.phase, ["claim", "create", "message", "complete"]), reason = choice(row.reason, ["accepted", "guarded", "content-conflict", "not-found", "unsupported-runtime", "stale-server", "adapter-unavailable", "transport-unknown", "invalid-session"]);
  if (outcome === "accepted" && (row.runtime !== "opencode" || phase !== "complete" || row.sessionId === null || row.messageId === null || row.serverIdentity === null || reason !== "accepted")) throw new TaskInputError("Unproven task acceptance");
  if (row.messageId !== null && row.messageId !== `msg_${lookup.requestId.replaceAll("-", "")}`) throw new TaskInputError("Task message identity mismatch");
  switch (outcome) {
    case "accepted": break;
    case "outcome-unknown": if (phase === "complete" || reason !== "guarded" && reason !== "transport-unknown" || phase === "message" && (row.sessionId === null || row.messageId === null)) throw new TaskInputError("Contradictory unknown task outcome"); break;
    case "rejected": if (phase !== "claim" || !["stale-server", "adapter-unavailable", "invalid-session"].includes(reason)) throw new TaskInputError("Contradictory task rejection"); break;
    case "conflict": if (phase !== "claim" || reason !== "content-conflict") throw new TaskInputError("Contradictory task conflict"); break;
    case "not-found": if (phase !== "claim" || reason !== "not-found" || row.sessionId !== null || row.messageId !== null || row.serverIdentity !== null) throw new TaskInputError("Contradictory missing task receipt"); break;
    case "unsupported": if (phase !== "claim" || reason !== "unsupported-runtime" || row.runtime === "opencode") throw new TaskInputError("Contradictory unsupported task runtime"); break;
  }
  return taskReceipt(lookup, { runtime: row.runtime, serverIdentity: row.serverIdentity, sessionId: row.sessionId, messageId: row.messageId, outcome, phase, reason });
}
function choice<const T extends string>(value: unknown, choices: readonly T[]): T { const found = choices.find(item => item === value); if (found === undefined) throw new TaskInputError("Invalid task receipt state"); return found; }
