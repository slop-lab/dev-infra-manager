import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { object } from "./taskContract.ts";
import type { TaskConnection } from "./taskHttp.ts";
const execute = promisify(execFile);
export async function taskCommand(file: string, args: string[], signal: AbortSignal) {
  const pending = execute(file, args, { signal, timeout: 3000, maxBuffer: 16384 }); pending.child.stdin?.end();
  const value: unknown = JSON.parse((await pending).stdout); return object(value);
}
export async function ownedTaskIdentity(home: string, signal: AbortSignal) {
  const value = await taskCommand(process.execPath, [join(home, ".local/share/dim-agent-tools/opencode-team-metadata.mjs"), "--server-identity"], signal);
  if (typeof value.identity !== "string" || !/^[a-f0-9]{64}$/.test(value.identity) || typeof value.directory !== "string" || !value.directory.startsWith("/") || typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw Error("Owned server identity unavailable");
  return { serverIdentity: value.identity, directory: value.directory, port: value.port };
}
export async function ownedTaskConnection(home: string, signal: AbortSignal): Promise<TaskConnection> {
  const helper = join(home, ".local/share/dim-agent-tools"), server = await taskCommand("bash", [join(helper, "opencode-server.bash"), "status", "--json"], signal);
  const identity = await ownedTaskIdentity(home, signal);
  if (server.state !== "running" || server.port !== identity.port || server.url !== `http://127.0.0.1:${identity.port}` || typeof server.credentialsFile !== "string" || !server.credentialsFile.startsWith(home + "/")) throw Error("Owned task server unavailable");
  const credentials = await taskCommand("bash", [join(helper, "opencode-server.bash"), "credentials", "--json"], signal);
  if (credentials.username !== "opencode" || typeof credentials.password !== "string" || !/^[\x20-\x7e]{12,128}$/.test(credentials.password)) throw Error("Owned task credentials unavailable");
  return { origin: server.url, directory: identity.directory, serverIdentity: identity.serverIdentity, authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`, lockFile: join(dirname(server.credentialsFile), "launch.lock") };
}
