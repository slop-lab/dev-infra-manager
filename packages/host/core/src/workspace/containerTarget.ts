import { createHash } from "node:crypto";
import net from "node:net";
import { UserError } from "../errors.js";
import type { StreamingCommandRunner } from "../types.js";
import type { WorkspaceRecord } from "./models.js";
import type {
  ResolvedWorkspaceRuntimeTarget,
  WorkspaceRuntimeTarget
} from "./service.js";
import type { WorkspaceRuntimeInspection } from "./runtime.js";
import { workspaceRuntimeResources } from "./runtimeResources.js";

type ContainerTargetContext = {
  readonly runner: StreamingCommandRunner;
  readonly record: WorkspaceRecord;
  readonly target: WorkspaceRuntimeTarget;
  readonly inspect: () => Promise<WorkspaceRuntimeInspection | undefined>;
};

export async function resolveContainerWorkspaceTarget(
  context: ContainerTargetContext
): Promise<ResolvedWorkspaceRuntimeTarget> {
  const inspected = await context.inspect();
  if (!inspected?.running) throw new UserError(`workspace '${context.record.name}' is not running`);
  const resources = workspaceRuntimeResources(context.record);
  const container = await context.runner.run("docker", ["container", "inspect", inspected.id, "--format", "{{json .}}"]);
  const value = inspection(container.exitCode, container.stdout, container.stderr);
  if (value.Id !== inspected.id) throw new UserError("workspace container identity changed during route resolution");
  const agentIp = ipAddress(object(object(object(value.NetworkSettings).Networks)[resources.network]).IPAddress);
  let host = "127.0.0.1";
  let fingerprint = inspected.id;
  const nestedName = context.target.containers[0];
  if (nestedName !== undefined) {
    const nested = await context.runner.run("docker", ["exec", "--user", "dim", inspected.id,
      "docker", "container", "inspect", nestedName, "--format", "{{json .}}"]);
    const selected = inspection(nested.exitCode, nested.stdout, nested.stderr);
    if (typeof selected.Id !== "string" || object(selected.State).Running !== true) throw new UserError("workspace target container is not running");
    const addresses = Object.values(object(object(selected.NetworkSettings).Networks)).map((network) => object(network).IPAddress);
    const address = addresses.find((candidate) => typeof candidate === "string" && net.isIP(candidate));
    host = ipAddress(address);
    fingerprint += `/${selected.Id}`;
  }
  const key = createHash("sha256").update(JSON.stringify([context.record.id, fingerprint, context.target])).digest("hex");
  const relay = await context.runner.run("docker", ["exec", "--user", "dim", inspected.id, "node", "--input-type=commonjs", "-e", relayLauncher,
    Buffer.from(JSON.stringify({ key, listenHost: agentIp, host, port: context.target.port })).toString("base64url")]);
  if (relay.exitCode !== 0) throw new UserError(`cannot start workspace route relay: ${relay.stderr.trim()}`);
  const response = object(JSON.parse(relay.stdout));
  if (!Number.isSafeInteger(response.port) || Number(response.port) < 1 || Number(response.port) > 65535) throw new UserError("workspace relay returned an invalid port");
  return { protocol: context.target.protocol, host: agentIp, port: Number(response.port), fingerprint };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function inspection(code: number, output: string, error: string): Record<string, unknown> {
  if (code !== 0) throw new UserError(`cannot inspect workspace route target: ${error.trim()}`);
  try {
    return object(JSON.parse(output));
  } catch {
    throw new UserError("workspace target inspection is invalid");
  }
}

function ipAddress(value: unknown): string {
  if (typeof value !== "string" || !net.isIP(value)) throw new UserError("workspace route target has no usable IP address");
  return value;
}

const relayServer = String.raw`
const fs = require("node:fs"), net = require("node:net");
const config = JSON.parse(Buffer.from(process.argv[1], "base64url").toString());
const server = net.createServer({ allowHalfOpen: true }, (client) => {
  const upstream = net.createConnection({ host: config.host, port: config.port, allowHalfOpen: true });
  client.pipe(upstream).pipe(client);
  client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
});
server.on("error", (error) => { process.stderr.write(error.message + "\n"); process.exit(1); });
server.listen(0, config.listenHost, () => {
  const state = { pid: process.pid, port: server.address().port };
  fs.writeFileSync(config.stateFile, JSON.stringify(state), { mode: 0o600 });
});
`;

const relayLauncher = String.raw`
const fs = require("node:fs"), path = require("node:path"), childProcess = require("node:child_process");
const config = JSON.parse(Buffer.from(process.argv[1], "base64url").toString());
const directory = "/tmp/dim-controller-routes";
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
config.stateFile = path.join(directory, config.key + ".json");
const existing = () => {
  try {
    const state = JSON.parse(fs.readFileSync(config.stateFile, "utf8"));
    const args = fs.readFileSync("/proc/" + state.pid + "/cmdline", "utf8").split("\0").filter(Boolean);
    if (args.at(-2) === "dim-controller-route" && args.at(-1) === config.key) return state;
  } catch {}
};
(async () => {
  let state = existing();
  if (!state) {
    const log = fs.openSync(path.join(directory, config.key + ".log"), "a", 0o600);
    const child = childProcess.spawn(process.execPath, ["--input-type=commonjs", "-e", ${JSON.stringify(relayServer)},
      Buffer.from(JSON.stringify(config)).toString("base64url"), "dim-controller-route", config.key],
      { detached: true, stdio: ["ignore", log, log] });
    fs.closeSync(log); child.unref();
    for (let attempt = 0; attempt < 100 && !(state = existing()); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!state) throw new Error("workspace route relay did not start");
  process.stdout.write(JSON.stringify(state) + "\n");
})().catch((error) => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
`;
