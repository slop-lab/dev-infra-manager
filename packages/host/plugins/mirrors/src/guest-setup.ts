/** Copied into an untrusted workspace. Only that workspace's nested engine is configured. */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
type GuestCacheEndpoints = Record<"docker" | "npm" | "pypi" | "apt", string>;
export interface GuestMirrorPayload { endpoints: GuestCacheEndpoints; proxy: string; setup: string; blockedHostnames: string[] }
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
function endpoints(input: unknown): GuestCacheEndpoints {
  const value = object(input);
  return { docker: endpoint(value.docker), npm: endpoint(value.npm), pypi: endpoint(value.pypi), apt: endpoint(value.apt) };
}
function blockedHosts(input: unknown): string[] {
  if (!Array.isArray(input) || !input.every((name: unknown): name is string => typeof name === "string" && /^[a-z0-9.-]+$/.test(name))) throw new Error("invalid blocked registry hosts");
  return input;
}
export function parseGuestMirrorPayload(input: unknown): GuestMirrorPayload {
  const value = object(input);
  if (typeof value.proxy !== "string" || typeof value.setup !== "string") throw new Error("invalid workspace mirror payload");
  return { endpoints: endpoints(value.endpoints), proxy: value.proxy, setup: value.setup, blockedHostnames: blockedHosts(value.blockedHostnames) };
}
export function mergeNpmRegistry(contents: string, registry: string): string {
  const base = contents.replace(/^# BEGIN DIM CACHE\r?\n[\s\S]*?^# END DIM CACHE(?:\r?\n|$)/gm, "");
  // User and project configuration retain precedence over this optional default.
  if (/^\s*(?:registry|["']registry["'])\s*=/im.test(base)) return base;
  return `${base}${base && !base.endsWith("\n") ? "\n" : ""}# BEGIN DIM CACHE\nregistry=${registry}/\n# END DIM CACHE\n`;
}
export function mergePipIndex(contents: string, index: string): string {
  const base = contents.replace(/^# BEGIN DIM CACHE\r?\n[\s\S]*?^# END DIM CACHE(?:\r?\n|$)/gm, "");
  const global = /^\[global\][ \t]*\r?$/im.exec(base);
  const block = `# BEGIN DIM CACHE\nindex-url = ${index}/\ntrusted-host = ${new URL(index).hostname}\n# END DIM CACHE\n`;
  if (!global) return `${base}${base && !base.endsWith("\n") ? "\n" : ""}[global]\n${block}`;
  const start = global.index + global[0].length, next = /^\[/m.exec(base.slice(start));
  const section = base.slice(start, next === null ? undefined : start + next.index);
  // An explicit global index or trust policy is an intentional operator override.
  if (/^\s*(?:index-url|trusted-host)\s*=/im.test(section)) return base;
  return `${base.slice(0, start)}\n${block}${base.slice(start).replace(/^\n/, "")}`;
}
export async function configureNpmUserFile(file: string, registry: string): Promise<void> {
  const metadata = await lstat(file).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error;
  });
  // Symlinks, non-owned files and other existing objects are explicit user policy.
  // Do not follow or replace them, and do not prevent other clients from starting.
  if (metadata && (!metadata.isFile() || metadata.uid !== process.getuid?.())) return;
  const previous = await optional(file) ?? "", next = mergeNpmRegistry(previous, registry);
  if (previous !== next) await atomic(file, next);
}
function clientSettings(value: GuestCacheEndpoints) {
  return { apt: `Acquire::http::Proxy "${value.apt}";\nAcquire::https::Proxy "DIRECT";\n`,
    npm: `registry=${value.npm}/\n`, pip: `[global]\nindex-url = ${value.pypi}/\ntrusted-host = ${new URL(value.pypi).hostname}\n` };
}
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed while configuring workspace mirrors`);
}
async function optional(file: string) { try { return await readFile(file, "utf8"); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; } }
async function atomic(file: string, value: string, mode = 0o600) { const temporary = `${file}.${randomUUID()}.tmp`; try { await writeFile(temporary, value, { mode, flag: "wx" }); await rename(temporary, file); } finally { await rm(temporary, { force: true }); } }
export async function installGuestMirrors(input: unknown) {
  const payload = parseGuestMirrorPayload(input), home = process.env.HOME;
  if (!home || !path.isAbsolute(home)) throw new Error("workspace home is unavailable");
  const directory = path.join(home, ".local/state/dim/host-mirrors");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error("workspace mirror directory is invalid");
  const aptConfig = path.join(directory, "apt.conf"), npmConfig = path.join(directory, "npmrc"), pipConfig = path.join(directory, "pip.conf"), daemonConfig = path.join(directory, "daemon.json"), proxy = path.join(directory, "guest-proxy.mjs"), setup = path.join(directory, "guest-setup.mjs");
  const config = { socket: "/var/run/docker.sock", engineSocket: "/var/run/dim-mirror-engine.sock",
    files: [{ source: aptConfig, target: "/etc/apt/apt.conf.d/99dim-mirrors" }, { source: daemonConfig, target: "/etc/docker/daemon.json" },
      { source: npmConfig, target: "/run/dim-caches/npmrc" }, { source: pipConfig, target: "/etc/pip.conf" }],
    environmentDefaults: ["NPM_CONFIG_GLOBALCONFIG=/run/dim-caches/npmrc"], blockedHostnames: payload.blockedHostnames };
  await configureNpmUserFile(path.join(home, ".npmrc"), payload.endpoints.npm);
  const signature = createHash("sha256").update(JSON.stringify(payload)).digest("hex"), signatureFile = path.join(directory, "configuration-id");
  if (await optional(signatureFile) !== signature) {
    // Stop the prior guest-only listener before replacing its persistent command.
    run("dim-workspace", ["service", "remove", "host-mirrors"]);
    const settings = clientSettings(payload.endpoints);
    await writeFile(aptConfig, settings.apt, { mode: 0o644 });
    await writeFile(npmConfig, settings.npm, { mode: 0o644 });
    await writeFile(pipConfig, settings.pip, { mode: 0o644 });
    await writeFile(daemonConfig, JSON.stringify({ "registry-mirrors": [payload.endpoints.docker], "insecure-registries": [new URL(payload.endpoints.docker).host] }));
    await atomic(proxy, payload.proxy); await atomic(setup, payload.setup);
    run("dim-workspace", ["service", "register", "--name", "host-mirrors", "--", "sudo", "-n", "node", proxy, JSON.stringify(config)]);
    await atomic(signatureFile, signature);
  }
  run("sudo", ["-n", "node", setup, "--root", JSON.stringify({ endpoints: payload.endpoints, blockedHostnames: payload.blockedHostnames, forceReload: !await proxyReady(config.socket, payload.endpoints.docker) })]);
  run("dim-workspace", ["service", "resume"]);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await proxyReady(config.socket, payload.endpoints.docker)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("workspace mirror socket did not become ready");
}
async function proxyReady(socketPath: string, registry: string) {
  return new Promise<boolean>((resolve) => {
    const outgoing = request({ socketPath, agent: false, path: "/v1.44/info", signal: AbortSignal.timeout(1_000) }, (response) => {
      let body = ""; response.setEncoding("utf8");
      response.on("data", (chunk: string) => { if (body.length + chunk.length > 2 * 1024 * 1024) outgoing.destroy(); else body += chunk; });
      response.on("error", () => resolve(false)); response.on("end", () => {
        try { const value = object(JSON.parse(body)), registryConfig = object(value.RegistryConfig);
          resolve(response.statusCode === 200 && response.headers["x-dim-mirror-proxy"] === "1" && Array.isArray(registryConfig.Mirrors)
            && registryConfig.Mirrors.some((entry: unknown) => typeof entry === "string" && new URL(entry).origin === registry));
        } catch { resolve(false); }
      });
    }); outgoing.on("error", () => resolve(false)); outgoing.end();
  });
}

export async function configureGuestDaemon(input: unknown) {
  const value = object(input);
  if (typeof value.forceReload !== "boolean") throw new Error("invalid workspace daemon configuration");
  const targets = endpoints(value.endpoints), blockedHostnames = blockedHosts(value.blockedHostnames), settings = clientSettings(targets);
  await mkdir("/etc/apt/apt.conf.d", { recursive: true });
  for (const [file, contents] of [["/etc/apt/apt.conf.d/99dim-mirrors", settings.apt],
    ["/etc/npmrc", mergeNpmRegistry(await optional("/etc/npmrc") ?? "", targets.npm)],
    ["/etc/pip.conf", mergePipIndex(await optional("/etc/pip.conf") ?? "", targets.pypi)]] as const) {
    if (await optional(file) !== contents) await atomic(file, contents, 0o644);
  }
  const endpoint = new URL(targets.docker);
  await mkdir("/etc/docker", { recursive: true });
  const before = await optional("/etc/docker/daemon.json"), config = before === undefined ? {} : object(JSON.parse(before));
  const next = JSON.stringify({ ...config, "registry-mirrors": [endpoint.origin], "insecure-registries": [...new Set([...(Array.isArray(config["insecure-registries"]) ? config["insecure-registries"].filter((entry: unknown): entry is string => typeof entry === "string") : []), endpoint.host])] });
  if (before !== next) await atomic("/etc/docker/daemon.json", next);
  const hosts = await readFile("/etc/hosts", "utf8");
  const base = hosts.replace(/\n?# BEGIN DIM HOST MIRRORS\n[\s\S]*?# END DIM HOST MIRRORS\n?/g, "\n");
  const nextHosts = `${base.trimEnd()}\n# BEGIN DIM HOST MIRRORS\n127.0.0.1 ${blockedHostnames.join(" ")}\n# END DIM HOST MIRRORS\n`;
  if (hosts !== nextHosts) await writeFile("/etc/hosts", nextHosts);
  const pid = (await readFile("/var/run/docker.pid", "utf8")).trim();
  if (!/^[1-9][0-9]*$/.test(pid) || (await readFile(`/proc/${pid}/comm`, "utf8")).trim() !== "dockerd") throw new Error("nested Docker process cannot be identified");
  if (before !== next || value.forceReload) process.kill(Number(pid), "SIGHUP");
}
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url && process.argv[2] === "--root") {
  void configureGuestDaemon(JSON.parse(process.argv[3] ?? "null")).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "workspace mirror setup failed"); process.exitCode = 1; });
}
