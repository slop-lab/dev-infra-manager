import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { ContainerWorkspaceRuntime, ProcessRunner, UserError, WorkspaceStore,
  workspaceRuntimeResources, type StreamingCommandRunner, type WorkspaceRecord } from "@slop-lab/dim-core/workspace";
import type { ControllerWorkspace, ResolvedWorkspaceTarget, WorkspaceTarget } from "./controller.js";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import { nativeWorkspaceAttachmentFile, readNativeWorkspaceAttachment } from "./nativeWorkspaceAttachment.js";
import { WorkspaceGrantStore } from "./workspaceGrantStore.js";

export function controllerWorkspaceStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.DIM_STATE_ROOT ?? path.join(os.homedir(), ".local/state/dim"));
}

export async function requireControllerWorkspace(workspace: ControllerWorkspace, stateRoot = controllerWorkspaceStateRoot()): Promise<WorkspaceRecord> {
  const record = await new WorkspaceStore(stateRoot).read(workspace.name);
  if (record.id !== workspace.id || !record.initialized || record.phase === "discarding") throw new UserError("workspace plugin identity is no longer current");
  return record;
}

/** Optional plugin operations observe core records; they never own workspace lifecycle. */
export class ControllerWorkspaces {
  readonly store: WorkspaceStore;
  private readonly grants: WorkspaceGrantStore;
  private readonly runtime: ContainerWorkspaceRuntime;
  constructor(private readonly lifecycle: Pick<LifecycleOptions, "stateRoot">,
    private readonly runner: StreamingCommandRunner = new ProcessRunner(), stateRoot = controllerWorkspaceStateRoot()) {
    this.store = new WorkspaceStore(stateRoot);
    this.grants = new WorkspaceGrantStore(lifecycle.stateRoot);
    this.runtime = new ContainerWorkspaceRuntime(runner);
  }

  async ensureGrant(name: string, expectedWorkspaceId?: string): Promise<string> {
    return this.store.withLock(name, async () => {
      const record = await this.store.read(name);
      if (expectedWorkspaceId !== undefined && record.id !== expectedWorkspaceId) throw new UserError("workspace plugin identity changed");
      if (!record.initialized || record.phase === "discarding") throw new UserError(`workspace '${name}' is unavailable for plugins`);
      return this.grants.ensure(record);
    });
  }
  async authenticate(token: string): Promise<ControllerWorkspace | undefined> {
    const record = await this.grants.authenticate(token, (name) => this.store.read(name));
    return record ? this.describe(record) : undefined;
  }
  async list(): Promise<ControllerWorkspace[]> {
    const records = await this.store.list();
    return Promise.all(records.filter((record) => record.initialized && record.phase !== "discarding").map((record) => this.describe(record)));
  }
  async run<T>(workspace: ControllerWorkspace, operation: () => Promise<T>): Promise<T> {
    return this.store.withLock(workspace.name, async () => { await this.current(workspace); return operation(); });
  }
  async resolveTarget(workspace: ControllerWorkspace, target: WorkspaceTarget): Promise<ResolvedWorkspaceTarget> {
    validateTarget(target);
    const record = await this.current(workspace);
    const inspected = await this.runtime.inspect(record);
    if (!inspected?.running) throw new UserError(`workspace '${record.name}' is not running`);
    const resources = workspaceRuntimeResources(record);
    const container = await this.runner.run("docker", ["container", "inspect", inspected.id, "--format", "{{json .}}"]);
    const value = inspection(container.exitCode, container.stdout, container.stderr);
    if (value.Id !== inspected.id) throw new UserError("workspace container identity changed during route resolution");
    const agentIp = ipAddress(object(object(object(value.NetworkSettings).Networks)[resources.network]).IPAddress);
    let host = "127.0.0.1", fingerprint = inspected.id;
    if (target.containers.length) {
      const nested = await this.runner.run("docker", ["exec", "--user", "dim", inspected.id,
        "docker", "container", "inspect", target.containers[0]!, "--format", "{{json .}}"]);
      const selected = inspection(nested.exitCode, nested.stdout, nested.stderr);
      if (typeof selected.Id !== "string" || object(selected.State).Running !== true) throw new UserError("workspace target container is not running");
      const addresses = Object.values(object(object(selected.NetworkSettings).Networks)).map((network) => object(network).IPAddress);
      const address = addresses.find((candidate) => typeof candidate === "string" && net.isIP(candidate));
      host = ipAddress(address); fingerprint += `/${selected.Id}`;
    }
    const key = createHash("sha256").update(JSON.stringify([record.id, fingerprint, target])).digest("hex");
    const relay = await this.runner.run("docker", ["exec", "--user", "dim", inspected.id, "node", "--input-type=commonjs", "-e", relayLauncher,
      Buffer.from(JSON.stringify({ key, listenHost: agentIp, host, port: target.port })).toString("base64url")]);
    if (relay.exitCode !== 0) throw new UserError(`cannot start workspace route relay: ${relay.stderr.trim()}`);
    const response = object(JSON.parse(relay.stdout));
    if (!Number.isSafeInteger(response.port) || Number(response.port) < 1 || Number(response.port) > 65535) throw new UserError("workspace relay returned an invalid port");
    await this.current(workspace);
    return { protocol: target.protocol, host: agentIp, port: Number(response.port), fingerprint };
  }
  private async current(workspace: ControllerWorkspace): Promise<WorkspaceRecord> {
    return requireControllerWorkspace(workspace, this.store.root);
  }
  private async describe(record: WorkspaceRecord): Promise<ControllerWorkspace> {
    const base = { id: record.id, name: record.name };
    try {
      const attachment = await readNativeWorkspaceAttachment(nativeWorkspaceAttachmentFile(this.lifecycle.stateRoot, record.id));
      if (attachment.workspaceId !== record.id || attachment.workspaceName !== record.name
        || attachment.workspaceStateRoot !== this.store.root) throw new UserError("workspace native attachment conflicts with its core identity");
      return { ...base, projectId: attachment.projectId, projectName: attachment.projectName };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return base;
      throw error;
    }
  }
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function inspection(code: number, output: string, error: string): Record<string, unknown> {
  if (code !== 0) throw new UserError(`cannot inspect workspace route target: ${error.trim()}`);
  try { return object(JSON.parse(output)); } catch { throw new UserError("workspace target inspection is invalid"); }
}
function ipAddress(value: unknown): string {
  if (typeof value !== "string" || !net.isIP(value)) throw new UserError("workspace route target has no usable IP address");
  return value;
}
function validateTarget(target: WorkspaceTarget): void {
  if (!target || !Array.isArray(target.containers) || target.containers.length > 1
    || target.containers.some((name) => typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name))) {
    throw new UserError("target.containers must contain zero or one workspace container name");
  }
  if (!Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65535) throw new UserError("target.port must be between 1 and 65535");
  if (!["http", "https", "tcp"].includes(target.protocol)) throw new UserError("target.protocol must be http, https or tcp");
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
