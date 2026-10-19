/** Copied into an untrusted workspace. Only that workspace's nested engine is configured. */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
export interface GuestMirrorPayload { registry: string; apt: string; proxy: string; setup: string; blockedHostnames: string[] }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid workspace mirror input");
  return value as Record<string, unknown>;
}
export function parseGuestMirrorPayload(input: unknown): GuestMirrorPayload {
  const value = object(input);
  for (const key of ["registry", "apt", "proxy", "setup"]) if (typeof value[key] !== "string") throw new Error("invalid workspace mirror payload");
  const registry = String(value.registry), apt = String(value.apt);
  for (const endpoint of [registry, apt]) { const url = new URL(endpoint); if (url.protocol !== "http:" || url.origin !== endpoint || url.username || url.password || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)) throw new Error("mirror endpoint must be a private host HTTP origin"); }
  if (!Array.isArray(value.blockedHostnames) || value.blockedHostnames.some((name: unknown) => typeof name !== "string" || !/^[a-z0-9.-]+$/.test(name))) throw new Error("invalid blocked registry hosts");
  return { registry, apt, proxy: String(value.proxy), setup: String(value.setup), blockedHostnames: value.blockedHostnames as string[] };
}
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed while configuring workspace mirrors`);
}
async function optional(file: string) { try { return await readFile(file, "utf8"); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; } }
async function atomic(file: string, value: string) { const temporary = `${file}.${randomUUID()}.tmp`; try { await writeFile(temporary, value, { mode: 0o600, flag: "wx" }); await rename(temporary, file); } finally { await rm(temporary, { force: true }); } }
export async function installGuestMirrors(input: unknown) {
  const payload = parseGuestMirrorPayload(input), home = process.env.HOME;
  if (!home || !path.isAbsolute(home)) throw new Error("workspace home is unavailable");
  const directory = path.join(home, ".local/state/dim/host-mirrors");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error("workspace mirror directory is invalid");
  const aptConfig = path.join(directory, "apt.conf"), daemonConfig = path.join(directory, "daemon.json"), proxy = path.join(directory, "guest-proxy.mjs"), setup = path.join(directory, "guest-setup.mjs");
  const config = { socket: "/var/run/docker.sock", engineSocket: "/var/run/dim-mirror-engine.sock", aptConfig, daemonConfig, blockedHostnames: payload.blockedHostnames };
  const signature = createHash("sha256").update(JSON.stringify(payload)).digest("hex"), signatureFile = path.join(directory, "configuration-id");
  if (await optional(signatureFile) !== signature) {
    // Stop the prior guest-only listener before replacing its persistent command.
    run("dim-workspace", ["service", "remove", "host-mirrors"]);
    await writeFile(aptConfig, `Acquire::http::Proxy "${payload.apt}";\nAcquire::https::Proxy "DIRECT";\n`);
    await writeFile(daemonConfig, JSON.stringify({ "registry-mirrors": [payload.registry], "insecure-registries": [new URL(payload.registry).host] }));
    await atomic(proxy, payload.proxy); await atomic(setup, payload.setup);
    run("dim-workspace", ["service", "register", "--name", "host-mirrors", "--", "sudo", "-n", "node", proxy, JSON.stringify(config)]);
    await atomic(signatureFile, signature);
  }
  run("sudo", ["-n", "node", setup, "--root", JSON.stringify({ registry: payload.registry, apt: payload.apt, blockedHostnames: payload.blockedHostnames, forceReload: !await proxyReady(config.socket, payload.registry) })]);
  run("dim-workspace", ["service", "resume"]);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await proxyReady(config.socket, payload.registry)) return;
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
  if (typeof value.registry !== "string" || typeof value.apt !== "string" || typeof value.forceReload !== "boolean" || !Array.isArray(value.blockedHostnames) || value.blockedHostnames.some((name: unknown) => typeof name !== "string" || !/^[a-z0-9.-]+$/.test(name))) throw new Error("invalid workspace daemon configuration");
  const apt = new URL(value.apt);
  if (apt.protocol !== "http:" || apt.origin !== value.apt || apt.username || apt.password || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(apt.hostname)) throw new Error("invalid APT proxy endpoint");
  const aptConfiguration = `Acquire::http::Proxy "${apt.origin}";\nAcquire::https::Proxy "DIRECT";\n`;
  await mkdir("/etc/apt/apt.conf.d", { recursive: true });
  if (await optional("/etc/apt/apt.conf.d/99dim-mirrors") !== aptConfiguration) await atomic("/etc/apt/apt.conf.d/99dim-mirrors", aptConfiguration);
  const endpoint = new URL(value.registry);
  if (endpoint.protocol !== "http:" || endpoint.origin !== value.registry || endpoint.username || endpoint.password) throw new Error("invalid registry endpoint");
  await mkdir("/etc/docker", { recursive: true });
  const before = await optional("/etc/docker/daemon.json"), config = before === undefined ? {} : object(JSON.parse(before));
  const next = JSON.stringify({ ...config, "registry-mirrors": [endpoint.origin], "insecure-registries": [...new Set([...(Array.isArray(config["insecure-registries"]) ? config["insecure-registries"].filter((entry: unknown): entry is string => typeof entry === "string") : []), endpoint.host])] });
  if (before !== next) await atomic("/etc/docker/daemon.json", next);
  const hosts = await readFile("/etc/hosts", "utf8");
  const base = hosts.replace(/\n?# BEGIN DIM HOST MIRRORS\n[\s\S]*?# END DIM HOST MIRRORS\n?/g, "\n");
  const nextHosts = `${base.trimEnd()}\n# BEGIN DIM HOST MIRRORS\n127.0.0.1 ${value.blockedHostnames.join(" ")}\n# END DIM HOST MIRRORS\n`;
  if (hosts !== nextHosts) await writeFile("/etc/hosts", nextHosts);
  const pid = (await readFile("/var/run/docker.pid", "utf8")).trim();
  if (!/^[1-9][0-9]*$/.test(pid) || (await readFile(`/proc/${pid}/comm`, "utf8")).trim() !== "dockerd") throw new Error("nested Docker process cannot be identified");
  if (before !== next || value.forceReload) process.kill(Number(pid), "SIGHUP");
}
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url && process.argv[2] === "--root") {
  void configureGuestDaemon(JSON.parse(process.argv[3] ?? "null")).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "workspace mirror setup failed"); process.exitCode = 1; });
}
