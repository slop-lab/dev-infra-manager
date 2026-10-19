import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { UserError, type StreamingCommandRunner } from "@slop-lab/dim-core";
import { MirrorState } from "./cacheState.js";
import { createHostMirrorOwnership, extendHostMirrorOwnership, hostMirrorLabels, type HostMirrorOwnership } from "./hostMirrorOwnership.js";

/** Compiled protocol adapters supply these definitions; they are not user configuration. */
export interface CacheServiceDefinition {
  readonly name: string;
  readonly image: string;
  readonly port: number;
  readonly dataTarget: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly entrypoint?: readonly string[];
  readonly command?: readonly string[];
  readonly configFiles?: readonly { readonly name: string; readonly contents: string; readonly target: string }[];
}
export interface CacheServiceOptions { readonly stateRoot: string; readonly namespace?: string }
export interface CacheEndpoint { readonly host: string; readonly port: number }

export function cacheServiceNames(name: string, namespace = "dim-cache") {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || !/^[a-z][a-z0-9-]{0,31}$/.test(namespace)) throw new UserError("invalid host cache service name or namespace");
  const container = `${namespace}-${name}`;
  return { network: `${namespace}-network`, container, volume: `${container}-data` };
}

/** Reconcile only the selected local services. Persistent data never belongs to a workspace. */
export async function ensureCacheServices(
  runner: StreamingCommandRunner, options: CacheServiceOptions, definitions: readonly CacheServiceDefinition[]
): Promise<Record<string, CacheEndpoint>> {
  const namespace = options.namespace ?? "dim-cache";
  const network = cacheServiceNames("docker", namespace).network;
  if (new Set(definitions.map((entry) => entry.name)).size !== definitions.length) throw new UserError("duplicate host cache service definition");
  for (const definition of definitions) validateDefinition(definition);
  if (!definitions.length) return {};
  const state = new MirrorState(options.stateRoot, namespace);
  const release = await state.acquireCacheLock();
  try {
    const bridge = await requiredInspect(runner, "network", "bridge");
    const publicationHost = bridgeGateway(bridge);
    const ownership = extendHostMirrorOwnership(await state.readHostMirrorOwnership() ?? createHostMirrorOwnership(),
      definitions.flatMap((entry) => [`cache:${entry.name}`, `data:${entry.name}`]));
    await state.writeHostMirrorOwnership(ownership);
    const networkInfo = await ensureResource(runner, "network", network, "network", ownership);
    if (networkInfo.Driver !== "bridge" || networkInfo.Internal !== false || typeof networkInfo.Id !== "string") {
      throw new UserError(`Docker network '${network}' has unexpected runtime configuration`);
    }
    const endpoints: Record<string, CacheEndpoint> = {};
    for (const definition of definitions) {
      endpoints[definition.name] = await ensureService(runner, options.stateRoot, namespace, definition, ownership, networkInfo.Id, publicationHost);
    }
    return endpoints;
  } finally { await release(); }
}

async function ensureService(runner: StreamingCommandRunner, root: string, namespace: string, definition: CacheServiceDefinition,
  ownership: HostMirrorOwnership, networkId: string, publicationHost: string): Promise<CacheEndpoint> {
  const names = cacheServiceNames(definition.name, namespace);
  const volume = await ensureResource(runner, "volume", names.volume, `data:${definition.name}`, ownership);
  if (volume.Driver !== "local" || (volume.Options !== null && (!isRecord(volume.Options) || Object.keys(volume.Options).length))) {
    throw new UserError(`Docker volume '${names.volume}' has unexpected storage configuration`);
  }
  const configs = await configurationFiles(root, namespace, definition);
  const mounts = [{ type: "volume", source: names.volume, target: definition.dataTarget, writable: true },
    ...configs.map((file) => ({ type: "bind", source: file.source, target: file.target, writable: false }))];
  const fingerprint = createHash("sha256").update(JSON.stringify({ definition, publicationHost })).digest("hex");
  const existing = await inspect(runner, "container", names.container);
  if (existing) {
    const config = object(existing.Config);
    assertOwned(config.Labels, `cache:${definition.name}`, ownership, names.container);
    assertRuntime(existing, names, mounts, definition.port, publicationHost, networkId);
    const labels = object(config.Labels);
    if (labels["dim.cache-spec"] !== fingerprint || config.Image !== definition.image) {
      await command(runner, ["container", "rm", "--force", id(existing)], `replace cache '${definition.name}'`);
    } else {
      if (!containsEnvironment(config.Env, definition.environment ?? {})
        || ((definition.command !== undefined || definition.entrypoint !== undefined) && !same(config.Cmd, [...(definition.entrypoint?.slice(1) ?? []), ...(definition.command ?? [])]))
        || (definition.entrypoint !== undefined && !same(config.Entrypoint, definition.entrypoint.slice(0, 1)))) {
        throw new UserError(`Docker cache '${names.container}' has unexpected process configuration`);
      }
      if (object(existing.State).Running !== true) await command(runner, ["start", id(existing)], `start cache '${definition.name}'`);
      return endpoint(await requiredInspect(runner, "container", id(existing)), names.network, networkId, definition.port, publicationHost);
    }
  }
  const args = ["run", "--detach", "--name", names.container, "--restart", "unless-stopped", "--network", names.network,
    "--network-alias", names.container, "--publish", `${publicationHost}::${definition.port}/tcp`,
    ...hostMirrorLabels(`cache:${definition.name}`, ownership).flatMap((label) => ["--label", label]), "--label", `dim.cache-spec=${fingerprint}`,
    ...mounts.flatMap((mount) => ["--mount", `type=${mount.type},source=${mount.source},target=${mount.target}${mount.writable ? "" : ",readonly"}`]),
    ...Object.entries(definition.environment ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`])];
  if (definition.entrypoint?.[0]) args.push("--entrypoint", definition.entrypoint[0]);
  args.push(definition.image, ...(definition.entrypoint?.slice(1) ?? []), ...(definition.command ?? []));
  await command(runner, args, `create cache '${definition.name}'`);
  const created = await requiredInspect(runner, "container", names.container);
  assertOwned(object(created.Config).Labels, `cache:${definition.name}`, ownership, names.container);
  assertRuntime(created, names, mounts, definition.port, publicationHost, networkId);
  return endpoint(created, names.network, networkId, definition.port, publicationHost);
}

type Mount = { readonly type: string; readonly source: string; readonly target: string; readonly writable: boolean };
function assertRuntime(container: Record<string, unknown>, names: ReturnType<typeof cacheServiceNames>, mounts: readonly Mount[], port: number, publicationHost: string, networkId: string): void {
  const host = object(container.HostConfig), networks = object(object(container.NetworkSettings).Networks), actualMounts = container.Mounts;
  if (host.NetworkMode !== names.network || host.Privileged !== false || object(host.RestartPolicy).Name !== "unless-stopped"
    || !requestedPublicationMatches(container, port, publicationHost)
    || (object(container.State).Running === true && !publicationMatches(container, port, publicationHost))
    || Object.keys(networks).length !== 1 || !isRecord(networks[names.network]) || object(networks[names.network]).NetworkID !== networkId
    || !Array.isArray(actualMounts) || actualMounts.length !== mounts.length
    || !mounts.every((expected) => actualMounts.some((mount: unknown) => isRecord(mount) && mount.Type === expected.type
      && (expected.type === "volume" ? mount.Name : mount.Source) === expected.source
      && mount.Destination === expected.target && mount.RW === expected.writable))) {
    throw new UserError(`Docker cache '${names.container}' has unexpected runtime configuration`);
  }
}

function endpoint(container: Record<string, unknown>, network: string, networkId: string, port: number, publicationHost: string): CacheEndpoint {
  const connection = object(object(object(container.NetworkSettings).Networks)[network]);
  const host = connection.IPAddress;
  if (object(container.State).Running !== true || connection.NetworkID !== networkId || typeof host !== "string"
    || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.split(".").some((part) => Number(part) > 255)) {
    throw new UserError("owned host cache has no running private network endpoint");
  }
  const published = publicationMatches(container, port, publicationHost);
  if (!published) throw new UserError("owned host cache has no private host publication");
  return { host: publicationHost, port: published };
}

function bridgeGateway(bridge: Record<string, unknown>): string {
  const config = object(bridge.IPAM).Config;
  if (bridge.Driver !== "bridge" || bridge.Internal !== false || !Array.isArray(config)) throw new UserError("Docker default bridge has no IPv4 host gateway");
  const gateways = config.flatMap((item: unknown) => isRecord(item) && typeof item.Gateway === "string"
    && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(item.Gateway) && item.Gateway.split(".").every((part) => Number(part) <= 255) ? [item.Gateway] : []);
  if (gateways.length !== 1 || !gateways[0] || gateways[0] === "0.0.0.0") throw new UserError("Docker default bridge must have one IPv4 host gateway");
  return gateways[0];
}
function requestedPublicationMatches(container: Record<string, unknown>, port: number, host: string): boolean {
  const requested = object(object(container.HostConfig).PortBindings), request = requested[`${port}/tcp`];
  if (Object.keys(requested).length !== 1 || !Array.isArray(request) || request.length !== 1 || !isRecord(request[0]) || request[0].HostIp !== host) return false;
  const value = request[0].HostPort;
  return value === "" || value === "0" || (typeof value === "string" && /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65535);
}
/** Effective bindings are available only while the container is running. */
function publicationMatches(container: Record<string, unknown>, port: number, host: string): number | undefined {
  if (!requestedPublicationMatches(container, port, host)) return undefined;
  const requested = object(object(container.HostConfig).PortBindings), effective = object(object(container.NetworkSettings).Ports);
  const key = `${port}/tcp`, bound = effective[key];
  if (!Array.isArray(bound) || bound.length !== 1 || !isRecord(bound[0]) || bound[0].HostIp !== host
    || Object.entries(effective).some(([name, value]) => name !== key && value !== null)) return undefined;
  const allocated = bound[0].HostPort;
  if (typeof allocated !== "string" || !/^[1-9][0-9]{0,4}$/.test(allocated) || Number(allocated) > 65535) return undefined;
  const request: unknown = requested[key];
  if (!Array.isArray(request) || !isRecord(request[0]) || (request[0].HostPort !== "" && request[0].HostPort !== "0" && request[0].HostPort !== allocated)) return undefined;
  return Number(allocated);
}

async function ensureResource(runner: StreamingCommandRunner, type: "network" | "volume", name: string, resource: string,
  ownership: HostMirrorOwnership): Promise<Record<string, unknown>> {
  const existing = await inspect(runner, type, name);
  if (existing) { assertOwned(existing.Labels, resource, ownership, name); return existing; }
  await command(runner, [type, "create", ...hostMirrorLabels(resource, ownership).flatMap((label) => ["--label", label]), name], `create cache ${type}`);
  const created = await requiredInspect(runner, type, name);
  assertOwned(created.Labels, resource, ownership, name);
  return created;
}

async function inspect(runner: StreamingCommandRunner, type: "network" | "volume" | "container", name: string): Promise<Record<string, unknown> | undefined> {
  const result = await runner.run("docker", [type, "inspect", name, "--format", "{{json .}}"]);
  if (result.exitCode !== 0) {
    const diagnostic = type === "network" ? `Error response from daemon: network ${name} not found`
      : type === "volume" ? `Error response from daemon: get ${name}: no such volume` : `Error response from daemon: No such container: ${name}`;
    if (result.stderr.trim().toLowerCase() === diagnostic.toLowerCase()) return undefined;
    throw new UserError(`failed to inspect Docker ${type} '${name}': ${result.stderr.trim()}`);
  }
  let value: unknown;
  try { value = JSON.parse(result.stdout); } catch { throw new UserError(`invalid Docker ${type} inspection`); }
  return object(value);
}
async function requiredInspect(runner: StreamingCommandRunner, type: "network" | "volume" | "container", name: string) {
  const result = await inspect(runner, type, name);
  if (!result) throw new UserError(`Docker ${type} '${name}' disappeared during cache reconciliation`);
  return result;
}
async function command(runner: StreamingCommandRunner, args: string[], action: string): Promise<void> {
  const result = await runner.run("docker", args);
  if (result.exitCode !== 0) throw new UserError(`failed to ${action}: ${result.stderr.trim()}`);
}
function assertOwned(labels: unknown, resource: string, ownership: HostMirrorOwnership, name: string): void {
  const actual = object(labels);
  if (!hostMirrorLabels(resource, ownership).every((label) => { const split = label.indexOf("="); return actual[label.slice(0, split)] === label.slice(split + 1); })) {
    throw new UserError(`Docker resource '${name}' exists but is not managed by this host cache installation`);
  }
}
function id(value: Record<string, unknown>): string { if (typeof value.Id !== "string" || !value.Id) throw new UserError("Docker cache has no container identity"); return value.Id; }
function object(value: unknown): Record<string, unknown> { if (!isRecord(value)) throw new UserError("invalid Docker cache inspection object"); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function same(first: unknown, second: unknown): boolean { return JSON.stringify(first) === JSON.stringify(second); }
function containsEnvironment(value: unknown, required: Readonly<Record<string, string>>): boolean {
  return Array.isArray(value) && Object.entries(required).every(([key, contents]) => value.includes(`${key}=${contents}`));
}

async function configurationFiles(root: string, namespace: string, definition: CacheServiceDefinition) {
  const directory = path.resolve(root, "services", namespace, definition.name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files: { source: string; target: string }[] = [];
  for (const config of definition.configFiles ?? []) {
    const source = path.join(directory, config.name), temporary = `${source}.${randomUUID()}.tmp`;
    if (await readFile(source, "utf8").catch((error: unknown) => { if (isRecord(error) && error.code === "ENOENT") return undefined; throw error; }) !== config.contents) {
      try { await writeFile(temporary, config.contents, { flag: "wx", mode: 0o644 }); await rename(temporary, source); }
      finally { await rm(temporary, { force: true }); }
    }
    files.push({ source, target: config.target });
  }
  return files;
}
function validateDefinition(definition: CacheServiceDefinition): void {
  cacheServiceNames(definition.name);
  const files = definition.configFiles ?? [];
  if (!/^\S+@sha256:[a-f0-9]{64}$/.test(definition.image) || !Number.isInteger(definition.port) || definition.port < 1 || definition.port > 65535
    || !safeTarget(definition.dataTarget) || new Set(files.map((file) => file.name)).size !== files.length
    || new Set([definition.dataTarget, ...files.map((file) => file.target)]).size !== files.length + 1
    || files.some((file) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(file.name) || !safeTarget(file.target))
    || Object.entries(definition.environment ?? {}).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0"))
    || [definition.entrypoint, definition.command].some((args) => args !== undefined && (!args.length || args.some((arg) => arg.includes("\0"))))) {
    throw new UserError(`invalid compiled host cache definition '${definition.name}'`);
  }
}
function safeTarget(value: string): boolean { return path.posix.isAbsolute(value) && value !== "/" && path.posix.normalize(value) === value && !/[,\0]/.test(value); }
