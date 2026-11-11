import { Readable, Writable } from "node:stream";
import { UserError, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import type { WorkspaceCapabilityFact, WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";
import { parseExecutionStatus } from "./execution/parse.ts";
import { executionRevision, waitForExecutionChange } from "./execution/status.ts";

export async function executionStatus(input: unknown, workspace: WorkspaceRecord, context: WorkspaceHostPluginContext) {
  const selected = parseExecutionInput(input, false);
  return observe(selected.sessionId, workspace, context);
}

export async function executionOperation(operation: string, input: unknown, workspace: WorkspaceRecord, context: WorkspaceHostPluginContext) {
  const selected = parseExecutionInput(input, operation === "execution.wait");
  const read = (signal: AbortSignal) => observe(selected.sessionId, workspace, { ...context, signal });
  if (operation === "execution.wait") return waitForExecutionChange({ observe: read, signal: context.signal, timeoutMs: selected.timeoutSeconds * 1000, ...(selected.since === undefined ? {} : { since: selected.since }) });
  const evidence = await read(context.signal);
  return { evidence, revision: executionRevision(evidence) };
}

async function observe(sessionId: string, workspace: WorkspaceRecord, context: WorkspaceHostPluginContext) {
  const current = await context.service.show(workspace.name);
  if (current.id !== workspace.id || !current.initialized || current.phase !== "running" || current.runtimeStatus !== "running") throw new UserError("Execution workspace identity or lifecycle changed");
  const cancellation = new AbortController();
  const signal = AbortSignal.any([context.signal, cancellation.signal, AbortSignal.timeout(12_000)]);
  const chunks: Buffer[] = []; let bytes = 0;
  const stdout = new Writable({ write(chunk: Buffer, _encoding, done) {
    bytes += chunk.length;
    if (bytes <= 128 * 1024) chunks.push(Buffer.from(chunk)); else cancellation.abort();
    done();
  } });
  const stderr = new Writable({ write(_chunk, _encoding, done) { done(); } });
  try {
    const code = await context.service.exec(workspace.name, ["bash", "-c", 'exec node "$HOME/.local/share/dim-agent-tools/execution/guest.ts"'], {
      workspaceId: workspace.id, signal, stdin: Readable.from([JSON.stringify({ sessionId })]), stdout, stderr
    });
    context.signal.throwIfAborted();
    if (code !== 0 || bytes > 128 * 1024) throw Error("Execution helper unavailable");
    const latest = await context.service.show(workspace.name);
    if (latest.id !== workspace.id || !latest.initialized || latest.phase !== "running" || latest.runtimeStatus !== "running") throw Error("Execution workspace changed");
    return parseExecutionStatus(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    context.signal.throwIfAborted();
    throw new UserError("Execution status unavailable; the installed agent-tools execution adapter must be present in this running workspace. No helpers were deployed or server started.");
  } finally { stdout.destroy(); stderr.destroy(); }
}

function parseExecutionInput(input: unknown, wait: boolean) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new UserError("Execution input must be an object");
  const row = Object.fromEntries(Object.entries(input));
  if (Object.keys(row).some(key => !(wait ? ["sessionId", "since", "timeoutSeconds"] : ["sessionId"]).includes(key)) || typeof row.sessionId !== "string" || !/^ses_[A-Za-z0-9]{1,100}$/.test(row.sessionId)) throw new UserError("Invalid execution input; select only a session identity");
  const timeoutSeconds = row.timeoutSeconds ?? 120;
  if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 180 || row.since !== undefined && (typeof row.since !== "string" || !/^[a-f0-9]{64}$/.test(row.since))) throw new UserError("Invalid execution wait bounds");
  return { sessionId: row.sessionId, timeoutSeconds, since: typeof row.since === "string" ? row.since : undefined };
}

export async function executionCapabilities(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext): Promise<readonly WorkspaceCapabilityFact[]> {
  let available = false;
  if (workspace.initialized && workspace.phase === "running") {
    const ignored = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
    const stdout = ignored(), stderr = ignored();
    try {
      available = await context.service.exec(workspace.name, ["bash", "-c", 'for file in execution/guest.ts execution/cli.ts execution/status.ts execution/projection.ts execution/monitor.ts execution/monitorMetadata.ts execution/monitorClient.ts execution/package.json opencode-server.bash opencode-runtime.bash opencode-team-metadata.mjs; do test -f "$HOME/.local/share/dim-agent-tools/$file" || exit 1; done'], { workspaceId: workspace.id, signal: AbortSignal.any([context.signal, AbortSignal.timeout(3000)]), stdout, stderr }) === 0;
    } catch { context.signal.throwIfAborted(); }
    finally { stdout.destroy(); stderr.destroy(); }
  }
  return [
    { name: "coding-agent-execution-status", description: "Read bounded OpenCode task, child and team activity; unknown is not idle and completion is not assessed", state: available ? "available" : "blocked", access: available ? { kind: "guest-operation", operation: "execution-status" } : { kind: "none" },
      ...(available ? {} : { reason: { code: "execution-adapter-unavailable", message: "The running workspace needs the reviewed agent-tools execution adapter; discovery never deploys it." } }) },
    { name: "coding-agent-task-submission", description: "Submit or message a coding-agent task", state: "unavailable", access: { kind: "none" }, reason: { code: "no-task-producer", message: "Agent-tools owns lifecycle and observation, but has no typed task-message submission operation. Direct OpenCode task delivery is not a DIM task API." } }
  ];
}
