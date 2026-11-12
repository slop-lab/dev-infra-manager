import { Readable, Writable } from "node:stream";
import { UserError, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import type { WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";
import { deployToolHelpers } from "./integration.js";
import { toolStatusScript } from "./toolStatus.js";

import { projectTeamMetadata } from "./teamMetadata.js";
import { executionOperation } from "./executionHost.js";
import { formatExecutionStatus } from "./execution/status.ts";
import { parseExecutionStatus } from "./execution/parse.ts";
import { formatTaskReceipt, taskConsoleOperation } from "./taskHost.js";
import { parseTaskReceipt } from "./execution/taskContract.ts";

const operations = ["tools.status", "tools.setup", "server.start", "server.status", "server.stop", "server.credentials", "server.password", "server.team-metadata", "execution.status", "execution.wait", "task.identity", "task.submit", "task.request"];

/** Capture only bounded machine output; guest stderr and installer logs never become Web responses. */
async function execute(context: WorkspaceHostPluginContext, workspace: WorkspaceRecord, command: string[], json = true, input?: unknown, timeoutMilliseconds = 175_000) {
  const cancellation = new AbortController();
  const signal = AbortSignal.any([context.signal, cancellation.signal, AbortSignal.timeout(timeoutMilliseconds)]);
  const chunks: Buffer[] = []; let bytes = 0, overflow = false;
  const stdout = new Writable({ write(chunk: Buffer, _encoding, callback) {
    if (json) { bytes += chunk.length; if (bytes <= 32 * 1024) chunks.push(Buffer.from(chunk)); else { overflow = true; cancellation.abort(); } }
    callback();
  } });
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const code = await context.service.exec(workspace.name, command, { workspaceId: workspace.id, stdout, stderr, signal, ...(input === undefined ? {} : { stdin: Readable.from([JSON.stringify(input)]) }) });
  if (code !== 0 || overflow) throw new UserError("Tool operation failed. Check that the workspace is running and the tool is configured; use dim tools on the selected host for private diagnostics.");
  if (!json) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new UserError("Tool operation returned an invalid response"); }
}

export async function invokeToolsConsole(operation: string, input: unknown, context: WorkspaceHostPluginContext) {
  if (!operations.includes(operation)) throw new UserError("Unknown tools operation");
  if (operation.startsWith("task.")) return taskConsoleOperation(operation, input, context);
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new UserError("Tools input must be an object");
  const value = input as Record<string, unknown>;
  const allowed = operation.startsWith("execution.") ? ["workspace", "workspaceId", "sessionId", ...(operation === "execution.wait" ? ["since", "timeoutSeconds"] : [])] : operation === "server.team-metadata" ? ["workspace", "workspaceId", "directory"] : operation === "tools.setup" ? ["workspace", "workspaceId", "tool"] : operation === "server.password" ? ["workspace", "workspaceId", "password"] : ["workspace", "workspaceId"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || typeof value.workspace !== "string" || typeof value.workspaceId !== "string"
    || !/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(value.workspace) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.workspaceId)
    || (operation === "tools.setup" && value.tool !== "opencode" && value.tool !== "codex")) throw new UserError("Invalid tools operation input");
  if (operation === "server.password" && (typeof value.password !== "string" || !/^[\x20-\x7e]{12,128}$/.test(value.password))) throw new UserError("Password must contain 12–128 printable ASCII characters");
  if (operation === "server.team-metadata" && value.directory !== undefined && (typeof value.directory !== "string" || !value.directory.startsWith("/") || value.directory.length > 4096 || /[\x00-\x1f\x7f]/.test(value.directory))) throw new UserError("Invalid monitor directory");
  const workspace = await context.service.show(value.workspace);
  if (workspace.id !== value.workspaceId) throw new UserError("Workspace was replaced; refresh before running tools");
  if (!workspace.initialized || workspace.phase !== "running" || workspace.runtimeStatus !== "running") throw new UserError("Start the workspace before running tools");
  if (["tools.setup", "server.start", "server.stop", "server.password"].includes(operation)) await deployToolHelpers(workspace, context);
  const identity = { workspace: workspace.name, workspaceId: workspace.id };
  if (operation.startsWith("execution.")) {
    const { workspace: _name, workspaceId: _id, ...selection } = value;
    return { ...identity, ...await executionOperation(operation, selection, workspace, context) };
  }
  if (operation === "server.team-metadata") {
    const response = await execute(context, workspace, ["bash", "-c", 'exec node "$HOME/.local/share/dim-agent-tools/opencode-team-metadata.mjs"'], true, value.directory === undefined ? {} : {directory:value.directory}, 10_000);
    return { ...identity, ...projectTeamMetadata(response) };
  }
  if (operation === "tools.setup") {
    await execute(context, workspace, ["bash", "-c", 'exec bash "$HOME/.local/share/dim-agent-tools/tool-setup.bash" "$1"', "dim-tools-setup", value.tool as string], false);
  }
  if (operation.startsWith("tools.")) {
    const status = await execute(context, workspace, ["node", "-e", toolStatusScript]);
    if (typeof status !== "object" || status === null) throw new UserError("Invalid tool status");
    return { ...status, ...identity };
  }
  const status = await execute(context, workspace, ["bash", "-c", 'exec bash "$HOME/.local/share/dim-agent-tools/opencode-server.bash" "$1" --json', "dim-opencode-server", operation.slice("server.".length)], true, operation === "server.password" ? { password: value.password } : undefined);
  if (typeof status !== "object" || status === null || Array.isArray(status)) throw new UserError("Invalid server status");
  const response = status as Record<string, unknown>;
  if (operation === "server.credentials") {
    if (response.username !== "opencode" || typeof response.password !== "string" || !/^[\x20-\x7e]{12,128}$/.test(response.password)) throw new UserError("Invalid server credentials");
    return { ...identity, username: response.username, password: response.password };
  }
  if (response.state !== "running" && response.state !== "stopped") throw new UserError("Invalid server status");
  // Guest output is untrusted: never forward extra fields from status or mutations.
  return { ...identity, directory: `/workspace${workspace.source.workingDirectory ? `/${workspace.source.workingDirectory}` : ""}`, state: response.state, ...Object.fromEntries(["port", "url", "username", "credentialsFile", "logFile"].filter(key => typeof response[key] === "string" || (key === "port" && typeof response[key] === "number")).map(key => [key, response[key]])) };
}

export async function runToolsConsole(args: string[], context: WorkspaceHostPluginContext): Promise<void> {
  const positional = args.filter((arg) => arg !== "--json");
  if (positional.length === 1 && positional[0] === "describe") {
    const workspaces = (await context.service.list()).map(({ name, id, phase, runtimeStatus }) => ({ name, id, phase: runtimeStatus === "running" ? phase : runtimeStatus }));
    process.stdout.write(JSON.stringify({ schemaVersion: 1, workspaces, tools: ["opencode", "codex"], operations }) + "\n");
    return;
  }
  const stdin = positional.length === 3 && positional[2] === "--input-stdin";
  if (positional[0] !== "invoke" || (!stdin && (positional.length !== 4 || positional[2] !== "--input"))) throw new UserError("usage: dim tools console describe|invoke OPERATION --input-stdin --json");
  let source = stdin ? "" : positional[3]!;
  const inputLimit = positional[1]?.startsWith("task.") ? 16384 : 4096;
  if (positional[1] === "task.submit" && !stdin) throw new UserError("Task text input must use --input-stdin");
  if (stdin) {
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      bytes += Buffer.byteLength(chunk as Buffer);
      if (bytes > inputLimit) throw new UserError("Tools input is too large");
      chunks.push(Buffer.from(chunk as Buffer));
    }
    try { source = positional[1]?.startsWith("task.") ? new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) : Buffer.concat(chunks).toString("utf8"); }
    catch { throw new UserError("Task input must be valid UTF-8"); }
  }
  if (Buffer.byteLength(source, "utf8") > inputLimit) throw new UserError("Tools input is too large");
  if (positional[1] === "server.password" && !stdin) throw new UserError("Password input must use --input-stdin");
  let input: unknown;
  try { input = JSON.parse(source) as unknown; } catch { throw new UserError("Tools input must be valid JSON"); }
  const result = await invokeToolsConsole(positional[1]!, input, context);
  if (!args.includes("--json") && positional[1]?.startsWith("execution.") && typeof result === "object" && result !== null && "evidence" in result) {
    process.stdout.write((result.evidence === null ? "unknown; no observation before deadline; completion not assessed" : formatExecutionStatus(parseExecutionStatus(result.evidence))) + ("outcome" in result ? `; wait ${result.outcome}` : "") + "\n");
  } else if (!args.includes("--json") && ["task.submit", "task.request"].includes(positional[1] ?? "")) process.stdout.write(formatTaskReceipt(parseTaskReceipt(result)) + "\n");
  else process.stdout.write(JSON.stringify(result) + "\n");
}
