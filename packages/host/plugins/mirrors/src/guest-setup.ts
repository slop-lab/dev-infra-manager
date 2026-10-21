/** Common workspace-side runner for reviewed cache client modules. */
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { MirrorClientConfiguration as ClientConfiguration, MirrorGuestClient as ClientModule } from "./protocol-plugin-api.js";
export interface GuestMirrorPayload {
  clients: readonly { kind: string; endpoint: string; source: string }[];
  proxy: string;
  setup: string;
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid workspace mirror input");
  return value as Record<string, unknown>;
}
function endpoint(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid workspace cache endpoint");
  const url = new URL(value);
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.split(".").some((part) => Number(part) > 255)) throw new Error("cache endpoint must be a private host HTTP origin");
  return url.origin;
}
export function parseGuestMirrorPayload(input: unknown): GuestMirrorPayload {
  const value = object(input);
  if (typeof value.proxy !== "string" || typeof value.setup !== "string" || !Array.isArray(value.clients) || !value.clients.length) throw new Error("invalid workspace mirror payload");
  const kinds = new Set<string>();
  const clients = value.clients.map((raw: unknown) => {
    const client = object(raw);
    if (typeof client.kind !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(client.kind) || kinds.has(client.kind)
      || typeof client.source !== "string" || !client.source) throw new Error("invalid or duplicate cache client module");
    kinds.add(client.kind);
    return { kind: client.kind, endpoint: endpoint(client.endpoint), source: client.source };
  });
  return { clients, proxy: value.proxy, setup: value.setup };
}
async function loadClient(file: string): Promise<ClientModule> {
  const value: unknown = await import(pathToFileURL(file).href);
  const module = object(value);
  if (typeof module.clientConfiguration !== "function" || typeof module.configureSystem !== "function"
    || module.configureUser !== undefined && typeof module.configureUser !== "function"
    || module.removeUser !== undefined && typeof module.removeUser !== "function"
    || module.removeSystem !== undefined && typeof module.removeSystem !== "function"
    || module.retiredClientConfiguration !== undefined && typeof module.retiredClientConfiguration !== "function") throw new Error("invalid reviewed cache client module");
  return module as unknown as ClientModule;
}
function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed while configuring workspace mirrors`);
}
async function optional(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
}
async function atomic(file: string, value: string, mode = 0o600): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, value, { mode, flag: "wx" }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
/** Keep the inode used by existing read-only nested bind mounts. */
export async function writeBoundConfiguration(file: string, contents: string): Promise<void> {
  const handle = await open(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || metadata.nlink !== 1) throw new Error("cache bind configuration must be an owned regular file with one link");
    const bytes = Buffer.from(contents);
    if (metadata.size === bytes.length && (await handle.readFile()).equals(bytes)) return;
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (!bytesWritten) throw new Error("cache bind configuration write made no progress");
      offset += bytesWritten;
    }
    await handle.truncate(bytes.length); await handle.chmod(0o644); await handle.sync();
  } finally { await handle.close(); }
}
function configurationFiles(settings: ClientConfiguration): readonly { target: string; contents: string }[] {
  return [...settings.files, ...(settings.dockerDaemonConfig === undefined ? [] : [{ target: "/etc/docker/daemon.json", contents: settings.dockerDaemonConfig }])];
}
export interface ActiveGuestClient { kind: string; file: string; endpoint: string; files: readonly { source: string; target: string }[] }
export function parseActiveGuestClients(input: unknown): ActiveGuestClient[] {
  if (!Array.isArray(input)) throw new Error("invalid active cache clients");
  return input.map((raw: unknown) => {
    const value = object(raw);
    if (typeof value.kind !== "string" || typeof value.file !== "string" || !path.isAbsolute(value.file)) throw new Error("invalid active cache client");
    if (!Array.isArray(value.files)) throw new Error("invalid active cache client files");
    const files = value.files.map((raw: unknown) => {
      const file = object(raw);
      if (typeof file.source !== "string" || !path.isAbsolute(file.source) || typeof file.target !== "string" || !path.isAbsolute(file.target)) throw new Error("invalid active cache client file");
      return { source: file.source, target: file.target };
    });
    return { kind: value.kind, file: value.file, endpoint: endpoint(value.endpoint), files };
  });
}
export function removedGuestClients(previous: readonly ActiveGuestClient[], current: readonly ActiveGuestClient[]): readonly ActiveGuestClient[] {
  return previous.filter((old) => !current.some((next) => next.kind === old.kind && next.file === old.file && next.endpoint === old.endpoint));
}
export async function configureGuestUser(current: readonly ActiveGuestClient[], removed: readonly ActiveGuestClient[]): Promise<void> {
  for (const client of removed) await (await loadClient(client.file)).removeUser?.(client.endpoint);
  for (const client of current) await (await loadClient(client.file)).configureUser?.(client.endpoint);
}
export async function retireGuestConfigurations(removed: readonly ActiveGuestClient[], current: readonly ActiveGuestClient[]): Promise<void> {
  const retainedSources = new Set(current.flatMap((client) => client.files.map(({ source }) => source)));
  for (const client of removed) {
    const module = await loadClient(client.file);
    if (!module.retiredClientConfiguration) {
      if (client.files.length) console.error(`Cache client '${client.kind}' has no retirement defaults; existing nested client mounts require manual cleanup.`);
      continue;
    }
    const neutral = new Map(configurationFiles(module.retiredClientConfiguration(client.endpoint)).map((file) => [file.target, file.contents]));
    for (const file of client.files) {
      if (retainedSources.has(file.source)) continue;
      const contents = neutral.get(file.target);
      if (contents === undefined) throw new Error(`cache client '${client.kind}' has no retirement default for '${file.target}'`);
      await writeBoundConfiguration(file.source, contents);
    }
  }
}
/** Apply reviewed modules without encoding any package-manager protocol here. */
export async function prepareGuestClients(clients: GuestMirrorPayload["clients"], directory: string) {
  const files: { source: string; target: string }[] = [], environmentDefaults: string[] = [], blockedHostnames: string[] = [];
  const modules: ActiveGuestClient[] = [];
  const targets = new Set<string>(), environmentKeys = new Set<string>();
  for (const client of clients) {
    // A content-addressed module URL avoids stale imports when the host refreshes assets.
    const moduleFile = path.join(directory, `client-${client.kind}-${createHash("sha256").update(client.source).digest("hex")}.mjs`);
    if (await optional(moduleFile) !== client.source) await atomic(moduleFile, client.source);
    const module = await loadClient(moduleFile), settings = module.clientConfiguration(client.endpoint);
    const ownedFiles: { source: string; target: string }[] = [];
    for (const setting of configurationFiles(settings)) {
      if (!path.isAbsolute(setting.target) || /[:,\0]/.test(setting.target) || targets.has(setting.target)) throw new Error("invalid or duplicate cache client target");
      targets.add(setting.target);
      const source = path.join(directory, `client-${client.kind}-${createHash("sha256").update(setting.target).digest("hex")}.conf`);
      await writeBoundConfiguration(source, setting.contents);
      const file = { source, target: setting.target };
      files.push(file); ownedFiles.push(file);
    }
    for (const [key, value] of Object.entries(settings.environmentDefaults ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0") || environmentKeys.has(key.toLowerCase())) throw new Error("invalid or duplicate cache environment default");
      environmentKeys.add(key.toLowerCase()); environmentDefaults.push(`${key}=${value}`);
    }
    modules.push({ kind: client.kind, file: moduleFile, endpoint: client.endpoint, files: ownedFiles });
    blockedHostnames.push(...settings.blockedHostnames ?? []);

  }
  return { files, environmentDefaults, blockedHostnames: [...new Set(blockedHostnames)], modules };
}
export async function installGuestMirrors(input: unknown): Promise<void> {
  const payload = parseGuestMirrorPayload(input), home = process.env.HOME;
  if (!home || !path.isAbsolute(home)) throw new Error("workspace home is unavailable");
  const directory = path.join(home, ".local/state/dim/host-mirrors");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("workspace mirror directory is invalid");
  const proxy = path.join(directory, "guest-proxy.mjs"), setup = path.join(directory, "guest-setup.mjs");
  const prepared = await prepareGuestClients(payload.clients, directory);
  const activeFile = path.join(directory, "active-clients.json"), previous = await optional(activeFile);
  const removed = removedGuestClients(previous === undefined ? [] : parseActiveGuestClients(JSON.parse(previous)), prepared.modules);
  await retireGuestConfigurations(removed, prepared.modules);
  await configureGuestUser(prepared.modules, removed);
  const config = { socket: "/var/run/docker.sock", engineSocket: "/var/run/dim-mirror-engine.sock", files: prepared.files, environmentDefaults: prepared.environmentDefaults, blockedHostnames: prepared.blockedHostnames };
  const signature = createHash("sha256").update(JSON.stringify(payload)).digest("hex"), signatureFile = path.join(directory, "configuration-id");
  if (await optional(signatureFile) !== signature) {
    run("dim-workspace", ["service", "remove", "host-mirrors"]);
    await atomic(proxy, payload.proxy); await atomic(setup, payload.setup);
    run("dim-workspace", ["service", "register", "--name", "host-mirrors", "--", "sudo", "-n", "node", proxy, JSON.stringify(config)]);
    await atomic(signatureFile, signature);
  }
  run("sudo", ["-n", "node", setup, "--root", JSON.stringify({ modules: prepared.modules, removedModules: removed })]);
  run("dim-workspace", ["service", "resume"]);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await proxyReady(config.socket)) { await atomic(activeFile, JSON.stringify(prepared.modules)); return; }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("workspace mirror socket did not become ready");
}
async function proxyReady(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const outgoing = request({ socketPath, agent: false, path: "/_ping", signal: AbortSignal.timeout(1_000) }, (response) => {
      response.resume(); response.once("error", () => resolve(false));
      response.once("end", () => resolve(response.statusCode === 200 && response.headers["x-dim-mirror-proxy"] === "1"));
    }); outgoing.once("error", () => resolve(false)); outgoing.end();
  });
}
export async function configureGuestDaemon(input: unknown): Promise<void> {
  const value = object(input);
  const current = parseActiveGuestClients(value.modules);
  const removed = value.removedModules === undefined ? [] : parseActiveGuestClients(value.removedModules);
  for (const client of removed) await (await loadClient(client.file)).removeSystem?.(client.endpoint);
  for (const client of current) await (await loadClient(client.file)).configureSystem(client.endpoint);
}
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url && process.argv[2] === "--root") {
  void configureGuestDaemon(JSON.parse(process.argv[3] ?? "null")).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "workspace mirror setup failed"); process.exitCode = 1; });
}
