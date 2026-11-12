import { Readable, Writable } from "node:stream";
import { UserError, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import type { WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";
import { exact, object, parseTaskLookup, parseTaskReceipt, parseTaskRequest, taskReceipt, uuidPattern, type TaskLookup, type TaskReceipt } from "./execution/taskContract.ts";

export async function taskConsoleOperation(operation: string, input: unknown, context: WorkspaceHostPluginContext) {
  const row = object(input);
  if (typeof row.workspace !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(row.workspace)) throw new UserError("Invalid task workspace name");
  const { workspace: name, ...selection } = row;
  return { workspace: name, ...await taskWorkspaceOperation(operation, selection, await context.service.show(name), context) };
}
export async function taskWorkspaceOperation(operation: string, input: unknown, workspace: WorkspaceRecord, context: WorkspaceHostPluginContext) {
  const row = object(input);
  if (row.workspaceId !== workspace.id) throw new UserError("Task workspace was replaced; use its exact current UUID");
  let selection: unknown;
  switch (operation) {
    case "task.submit": selection = parseTaskRequest(row); break;
    case "task.request": selection = parseTaskLookup(row); break;
    case "task.identity": exact(row, ["workspaceId", "runtime"]); if (row.runtime !== "opencode") throw new UserError("Unsupported task runtime; only opencode has a producer"); selection = { workspaceId: workspace.id, runtime: "opencode" }; break;
    default: throw new UserError("Unknown task operation");
  }
  const current = await context.service.show(workspace.name);
  if (current.id !== workspace.id || !current.initialized || current.phase !== "running" || current.runtimeStatus !== "running") throw new UserError("Task workspace identity or lifecycle changed");
  const chunks: Buffer[] = []; let size = 0;
  const cancellation = new AbortController(), signal = AbortSignal.any([context.signal, cancellation.signal, AbortSignal.timeout(12_000)]);
  const stdout = new Writable({ write(chunk: Buffer, _encoding, done) { size += chunk.length; if (size <= 16384) chunks.push(Buffer.from(chunk)); else cancellation.abort(); done(); } });
  const stderr = new Writable({ write(_chunk, _encoding, done) { done(); } });
  try {
    const exit = await context.service.exec(workspace.name, ["bash", "-c", 'exec node "$HOME/.local/share/dim-agent-tools/execution/taskGuest.ts" "$1"', "dim-task-operation", operation.slice("task.".length)], { workspaceId: workspace.id, signal, stdin: Readable.from([JSON.stringify(selection)]), stdout, stderr });
    if (exit !== 0 || size > 16384) throw Error("Task adapter transport unavailable");
    const latest = await context.service.show(workspace.name);
    if (latest.id !== workspace.id || !latest.initialized || latest.phase !== "running" || latest.runtimeStatus !== "running") throw Error("Task workspace changed during delivery");
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (operation === "task.identity") return parseTaskIdentity(value, workspace.id);
    const receipt = parseTaskReceipt(value);
    if (receipt.workspaceId !== workspace.id || receipt.requestId !== row.requestId) throw Error("Task receipt identity mismatch");
    if (operation === "task.submit" && receipt.outcome === "accepted" && (receipt.serverIdentity !== row.serverIdentity || receipt.runtime !== row.runtime || object(row.target).kind === "session" && receipt.sessionId !== object(row.target).sessionId)) throw Error("Task acceptance target mismatch");
    return receipt;
  } catch {
    if (operation !== "task.submit") throw new UserError("Task adapter unavailable; the reviewed producer and owned-server identity helper must be installed. No helpers were deployed.");
    const request = parseTaskRequest(row);
    if (request.runtime !== "opencode") return taskReceipt(request, { runtime: request.runtime, outcome: "unsupported", reason: "unsupported-runtime" });
    return taskReceipt(request, { serverIdentity: request.serverIdentity, reason: "transport-unknown", messageId: `msg_${request.requestId.replaceAll("-", "")}`, sessionId: request.target.kind === "session" ? request.target.sessionId : null });
  } finally { stdout.destroy(); stderr.destroy(); }
}
function parseTaskIdentity(input: unknown, workspaceId: string) {
  const row = object(input);
  if (row.schemaVersion !== 1 || row.runtime !== "opencode" || row.workspaceId !== workspaceId || !uuidPattern.test(workspaceId) || typeof row.serverIdentity !== "string" || !/^[a-f0-9]{64}$/.test(row.serverIdentity) || typeof row.directory !== "string" || !row.directory.startsWith("/") || row.directory.length > 4096 || typeof row.port !== "number" || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535) throw Error("Invalid task server identity");
  return { schemaVersion: 1, runtime: "opencode", workspaceId, serverIdentity: row.serverIdentity, directory: row.directory, port: row.port };
}
export function formatTaskReceipt(receipt: TaskReceipt): string { return `${receipt.outcome}; request ${receipt.requestId}; session ${receipt.sessionId ?? "unknown"}; phase ${receipt.phase}; completion not assessed`; }
