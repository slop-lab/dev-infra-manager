import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { request } from "node:http";

async function optional(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
}
async function atomic(file: string, contents: string, mode = 0o644): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, contents, { mode, flag: "wx" }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Docker daemon configuration");
  return value as Record<string, unknown>;
}
export function clientConfiguration(endpoint: string) {
  const url = new URL(endpoint);
  return { files: [], dockerDaemonConfig: JSON.stringify({ "registry-mirrors": [url.href], ...(url.protocol === "http:" ? { "insecure-registries": [url.host] } : {}) }),
    blockedHostnames: ["registry-1.docker.io", "auth.docker.io"] };
}
export async function configureSystem(endpoint: string): Promise<void> {
  const url = new URL(endpoint);
  await mkdir("/etc/docker", { recursive: true });
  const before = await optional("/etc/docker/daemon.json"), config = before === undefined ? {} : object(JSON.parse(before));
  const ownershipFile = "/etc/docker/.dim-cache-ownership.json";
  const previousOwnership = await optional(ownershipFile);
  if (previousOwnership === undefined) await atomic(ownershipFile, JSON.stringify({ endpoint: url.href,
    insecureAdded: !Array.isArray(config["insecure-registries"]) || !config["insecure-registries"].includes(url.host),
    previousMirrors: config["registry-mirrors"] }), 0o600);
  const next = JSON.stringify({ ...config, "registry-mirrors": [url.href], "insecure-registries": [...new Set([...(Array.isArray(config["insecure-registries"]) ? config["insecure-registries"].filter((entry: unknown): entry is string => typeof entry === "string") : []), url.host])] });
  if (before !== next) await atomic("/etc/docker/daemon.json", next, 0o600);
  const hosts = await readFile("/etc/hosts", "utf8");
  const base = hosts.replace(/\n?# BEGIN DIM HOST MIRRORS\n[\s\S]*?# END DIM HOST MIRRORS\n?/g, "\n");
  const nextHosts = `${base.trimEnd()}\n# BEGIN DIM HOST MIRRORS\n127.0.0.1 ${clientConfiguration(endpoint).blockedHostnames.join(" ")}\n# END DIM HOST MIRRORS\n`;
  if (hosts !== nextHosts) await writeFile("/etc/hosts", nextHosts);
  const pid = (await readFile("/var/run/docker.pid", "utf8")).trim();
  if (!/^[1-9][0-9]*$/.test(pid) || (await readFile(`/proc/${pid}/comm`, "utf8")).trim() !== "dockerd") throw new Error("nested Docker process cannot be identified");
  if (before !== next || !await proxyReady("/var/run/docker.sock", url.origin)) process.kill(Number(pid), "SIGHUP");
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

export function removeDockerConfiguration(config: Record<string, unknown>, endpoint: string, ownership: { insecureAdded: boolean; previousMirrors?: unknown }): Record<string, unknown> {
  const url = new URL(endpoint), next = { ...config };
  for (const [key, matches] of [
    ["registry-mirrors", (entry: unknown) => typeof entry === "string" && entry === url.href],
    ["insecure-registries", (entry: unknown) => entry === url.host]
  ] as const) {
    if (key === "insecure-registries" && !ownership.insecureAdded) continue;
    const entries = next[key];
    if (!Array.isArray(entries)) continue;
    const retained = entries.filter((entry: unknown) => !matches(entry));
    if (retained.length === entries.length) continue;
    if (retained.length) next[key] = retained;
    else if (key === "registry-mirrors" && ownership.previousMirrors !== undefined) next[key] = ownership.previousMirrors;
    // Docker SIGHUP reload retains omitted fields; explicit empty arrays reset them.
    else next[key] = [];
  }
  return next;
}
export function removeDockerHosts(contents: string): string {
  return contents.replace(`# BEGIN DIM HOST MIRRORS\n127.0.0.1 registry-1.docker.io auth.docker.io\n# END DIM HOST MIRRORS\n`, "");
}
export async function removeSystem(endpoint: string): Promise<void> {
  const file = "/etc/docker/daemon.json", before = await optional(file);
  const ownershipFile = "/etc/docker/.dim-cache-ownership.json", rawOwnership = await optional(ownershipFile);
  if (rawOwnership === undefined) return;
  const ownership = object(JSON.parse(rawOwnership));
  if (ownership.endpoint !== new URL(endpoint).href || typeof ownership.insecureAdded !== "boolean") return;
  let changed = false;
  if (before !== undefined) {
    const config = object(JSON.parse(before)), next = removeDockerConfiguration(config, endpoint,
      { insecureAdded: ownership.insecureAdded, previousMirrors: ownership.previousMirrors });
    if (JSON.stringify(config) !== JSON.stringify(next)) { await atomic(file, JSON.stringify(next), 0o600); changed = true; }
  }
  const hosts = await optional("/etc/hosts");
  if (hosts !== undefined && removeDockerHosts(hosts) !== hosts) await writeFile("/etc/hosts", removeDockerHosts(hosts));
  await rm(ownershipFile, { force: true });
  if (changed) {
    const pid = (await readFile("/var/run/docker.pid", "utf8")).trim();
    if (!/^[1-9][0-9]*$/.test(pid) || (await readFile(`/proc/${pid}/comm`, "utf8")).trim() !== "dockerd") throw new Error("nested Docker process cannot be identified");
    process.kill(Number(pid), "SIGHUP");
  }
}
export function retiredClientConfiguration() { return { files: [], dockerDaemonConfig: "{}" }; }
