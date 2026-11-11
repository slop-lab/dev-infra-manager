import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { inspectOpenCodeMonitor, type MonitorOptions } from "./monitor.ts";
import { authenticatedMonitorClient } from "./monitorClient.ts";
import type { ExecutionStatus } from "./status.ts";
import { projectExecutionStatus } from "./projection.ts";
import { parseOmoTeamMetadata } from "./monitorMetadata.ts";

const execute = promisify(execFile);
const unavailableTeams = { source: "unavailable", enabled: null, teams: [], truncated: false, unreadable: true };

export async function inspectOwnedOpenCode(parentSessionId: string, signal: AbortSignal): Promise<ExecutionStatus> {
  if (!/^ses_[A-Za-z0-9]{1,100}$/.test(parentSessionId)) throw Error("Invalid execution session");
  const helper = join(process.env.HOME ?? "", ".local/share/dim-agent-tools");
  const options: MonitorOptions = { parentSessionId, directory: "/", maxSessions: 16, maxDepth: 8, maxRequests: 48, recentMessages: 4, staleMinutes: 15, deadlineMs: 8000, requestTimeoutMs: 1500, signal };
  const command = async (file: string, args: string[]) => {
    const pending = execute(file, args, { signal, timeout: 6000, maxBuffer: 128 * 1024 });
    pending.child.stdin?.end();
    const result = await pending;
    const value: unknown = JSON.parse(result.stdout); return object(value);
  };
  try {
    const server = await command("bash", [join(helper, "opencode-server.bash"), "status", "--json"]);
    if (server.state !== "running" || !Number.isInteger(server.port) || typeof server.port !== "number" || server.port < 1 || server.port > 65535 || server.url !== `http://127.0.0.1:${server.port}` || typeof server.credentialsFile !== "string") throw Error("Owned OpenCode server unavailable");
    const owned = await command(process.execPath, [join(helper, "opencode-team-metadata.mjs"), "--server-identity"]);
    if (typeof owned.directory !== "string" || !owned.directory.startsWith("/") || typeof owned.identity !== "string" || !/^[a-f0-9]{64}$/.test(owned.identity) || owned.port !== server.port) throw Error("Owned OpenCode identity unavailable");
    const directory = owned.directory;
    const credentials = await command("bash", [join(helper, "opencode-server.bash"), "credentials", "--json"]);
    if (credentials.username !== "opencode" || typeof credentials.password !== "string" || !/^[\x20-\x7e]{12,128}$/.test(credentials.password)) throw Error("Owned credential unavailable");
    let team: unknown = unavailableTeams;
    try { team = await command(process.execPath, [join(helper, "opencode-team-metadata.mjs")]); }
    catch { signal.throwIfAborted(); }
    const evidence = await inspectOpenCodeMonitor({ ...options, directory }, parseOmoTeamMetadata(team, 16, 16),
      authenticatedMonitorClient(server.url, { username: credentials.username, password: credentials.password }, directory, signal));
    const current = await command("bash", [join(helper, "opencode-server.bash"), "status", "--json"]);
    const after = await command(process.execPath, [join(helper, "opencode-team-metadata.mjs"), "--server-identity"]);
    if (current.state !== "running" || current.url !== server.url || after.identity !== owned.identity || after.port !== owned.port || after.directory !== directory) throw Error("Owned server changed during observation");
    return projectExecutionStatus(evidence);
  } catch {
    signal.throwIfAborted();
    return projectExecutionStatus(await inspectOpenCodeMonitor(options, unavailableTeams, { async get() { throw Error("Owned OpenCode unavailable"); } }));
  }
}

function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid owned server metadata"); return Object.fromEntries(Object.entries(value)); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let source = "";
    for await (const chunk of process.stdin) { source += chunk.toString(); if (Buffer.byteLength(source) > 4096) throw Error("Execution input limit"); }
    const input = object(JSON.parse(source));
    if (Object.keys(input).some(key => key !== "sessionId") || typeof input.sessionId !== "string") throw Error("Invalid execution input");
    process.stdout.write(JSON.stringify(await inspectOwnedOpenCode(input.sessionId, AbortSignal.timeout(10_000))) + "\n");
  } catch { process.stderr.write("Execution status unavailable\n"); process.exitCode = 1; }
}
