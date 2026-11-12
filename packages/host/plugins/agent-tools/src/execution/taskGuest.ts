import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { object, parseTaskLookup, parseTaskReceipt, parseTaskRequest, taskReceipt, uuidPattern, type TaskLookup, type TaskRequest } from "./taskContract.ts";
import { lookupTask, readPrivateTaskJson, runTaskRequest, taskJournal } from "./taskJournal.ts";
import { deliverOpenCodeTask, taskTransport, type TaskConnection } from "./taskHttp.ts";
import { ownedTaskConnection, ownedTaskIdentity } from "./taskOwned.ts";
import { readTaskInput } from "./taskInput.ts";

async function workspaceIdentity(home: string, expected: string) {
  const value = object(await readPrivateTaskJson(join(home, ".config/dim/workspace.json")));
  if (value.workspaceId !== expected) throw Error("Task workspace identity changed");
}
export async function submitOwnedTask(home: string, input: TaskRequest, signal: AbortSignal) {
  await workspaceIdentity(home, input.workspaceId);
  return runTaskRequest(home, input, async () => {
    if (input.runtime !== "opencode") return taskReceipt(input, { runtime: input.runtime, outcome: "unsupported", reason: "unsupported-runtime" });
    signal.throwIfAborted();
    const connection = await ownedTaskConnection(home, signal);
    if (connection.serverIdentity !== input.serverIdentity) return taskReceipt(input, { serverIdentity: input.serverIdentity, outcome: "rejected", reason: "stale-server" });
    const lock = await open(connection.lockFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await lock.stat(); if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1) throw Error("Unsafe task launch lock");
      return await new Promise<ReturnType<typeof parseTaskReceipt>>((resolve, reject) => {
        const child = spawn("bash", ["-c", 'flock --shared --timeout 2 3 || exit 75; exec "$1" "$2" --dispatch', "dim-task-dispatch", process.execPath, fileURLToPath(import.meta.url)], { signal, stdio: ["pipe", "pipe", "pipe", lock.fd] });
        child.once("error", reject);
        const { stdin, stdout, stderr } = child;
        if (!stdin || !stdout || !stderr) { child.kill(); reject(Error("Task transport pipes unavailable")); return; }
        let output = "", bytes = 0; stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 16384) child.kill(); else output += chunk.toString(); }); stderr.resume();
        child.once("close", code => { try { if (code !== 0 || bytes > 16384) throw Error("Task dispatch transport lost"); resolve(parseTaskReceipt(JSON.parse(output))); } catch (error) { reject(error); } });
        stdin.on("error", reject);
        stdin.end(JSON.stringify({ request: input, connection }));
      });
    } finally { await lock.close(); }
  });
}
export async function requestOwnedTask(home: string, input: TaskLookup) { await workspaceIdentity(home, input.workspaceId); return lookupTask(home, input); }
export async function identifyTaskServer(home: string, input: unknown, signal: AbortSignal) {
  const row = object(input);
  if (Object.keys(row).some(key => !["workspaceId", "runtime"].includes(key)) || typeof row.workspaceId !== "string" || !uuidPattern.test(row.workspaceId) || row.runtime !== "opencode") throw Error("Unsupported task runtime or workspace identity");
  await workspaceIdentity(home, row.workspaceId);
  return { schemaVersion: 1, workspaceId: row.workspaceId, runtime: "opencode", ...await ownedTaskIdentity(home, signal) };
}
async function dispatch(home: string, value: unknown, signal: AbortSignal) {
  const envelope = object(value), input = parseTaskRequest(envelope.request), row = object(envelope.connection);
  if (typeof row.origin !== "string" || typeof row.directory !== "string" || typeof row.authorization !== "string" || typeof row.serverIdentity !== "string" || typeof row.lockFile !== "string") throw Error("Invalid private task transport");
  const connection: TaskConnection = { origin: row.origin, directory: row.directory, authorization: row.authorization, serverIdentity: row.serverIdentity, lockFile: row.lockFile };
  const verify = async () => { await workspaceIdentity(home, input.workspaceId); const current = await ownedTaskIdentity(home, signal); if (current.serverIdentity !== input.serverIdentity || current.directory !== connection.directory || connection.origin !== `http://127.0.0.1:${current.port}`) throw Error("Task server identity changed"); };
  return deliverOpenCodeTask(input, taskJournal(home, input), taskTransport(connection, signal, verify));
}
export async function runTaskOperation(operation: string, input: unknown, home: string, signal: AbortSignal) {
  switch (operation) {
    case "submit": return submitOwnedTask(home, parseTaskRequest(input), signal);
    case "request": return requestOwnedTask(home, parseTaskLookup(input));
    case "identity": return identifyTaskServer(home, input, signal);
    default: throw Error("Unsupported task operation");
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const input = await readTaskInput(process.stdin, process.argv[2] === "--dispatch" ? 32768 : 16384), signal = AbortSignal.timeout(10_000), home = process.env.HOME ?? "";
    const result = process.argv[2] === "--dispatch" ? await dispatch(home, input, signal) : await runTaskOperation(process.argv[2] ?? "", input, home, signal);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch { process.stderr.write("Task adapter unavailable; inspect the same request ID before any new delivery.\n"); process.exitCode = 1; }
}
