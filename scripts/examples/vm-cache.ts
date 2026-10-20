import { constants } from "node:fs";
import { lstat, open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
export const cacheKinds = ["apt", "docker", "npm"] as const;
export type VmCacheEndpoints = Partial<Record<typeof cacheKinds[number], string>>;
const dockerBlockedHosts = "127.0.0.1 registry-1.docker.io auth.docker.io";
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid cache URL catalog"); return Object.fromEntries(Object.entries(value)); }
export function cacheUrl(value: unknown, guest = false): string {
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) throw new Error("invalid cache URL");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("cache URLs must be HTTP(S) without credentials, queries or fragments");
  if (guest && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    if (url.protocol === "https:") throw new Error("loopback HTTPS cache requires a guest-reachable hostname with a valid certificate");
    url.hostname = "10.0.2.2";
  }
  return url.href;
}
export function selectedCacheEndpoints(input: unknown, activeClients = false): VmCacheEndpoints {
  let values: Record<string, unknown>;
  if (activeClients) {
    if (!Array.isArray(input)) throw new Error("invalid public active cache clients");
    values = {};
    for (const raw of input) {
      const client = object(raw);
      if (typeof client.kind !== "string") throw new Error("invalid active cache kind");
      // Only public kind/endpoint fields are consumed; module paths are never read or loaded.
      if (!cacheKinds.some((kind) => kind === client.kind)) continue;
      if (client.kind in values) throw new Error("duplicate active cache kind");
      values[client.kind] = client.endpoint;
    }
  } else {
    const catalog = object(input);
    if (catalog.schemaVersion !== 1 || Object.keys(catalog).some((key) => !["schemaVersion", "endpoints"].includes(key))) throw new Error("unsupported cache URL catalog");
    values = object(catalog.endpoints);
    if (Object.keys(values).length === 0) throw new Error("explicit cache URL catalog is empty");
    // Other protocols are valid catalog entries, but this bootstrap only needs these three clients.
    for (const value of Object.values(values)) cacheUrl(value);
  }
  const selected = Object.fromEntries(cacheKinds.flatMap((kind) => values[kind] === undefined ? [] : [[kind, cacheUrl(values[kind], true)]]));
  if (selected.apt && new URL(selected.apt).pathname !== "/") throw new Error("APT cache URL must have a root path");
  return selected;
}
export function cacheCloudInit(endpoints: VmCacheEndpoints): string {
  const files: { path: string; contents: string; append?: boolean; mode?: string }[] = [];
  if (Object.keys(endpoints).length === 0) return "";
  files.push({ path: "/etc/dim-examples-cache.json", contents: `${JSON.stringify({ schemaVersion: 1, endpoints })}\n` });
  if (endpoints.apt) files.push({ path: "/etc/apt/apt.conf.d/99dim-examples-cache", contents: `Acquire::http::Proxy "${endpoints.apt}";\nAcquire::https::Proxy "DIRECT";\n` });
  if (endpoints.npm) {
    files.push({ path: "/etc/npmrc", contents: `registry=${endpoints.npm.replace(/\/$/, "")}/\n` });
    files.push({ path: "/etc/environment", contents: "NPM_CONFIG_GLOBALCONFIG=/etc/npmrc\n", append: true, mode: "0644" });
  }
  if (endpoints.docker) files.push({ path: "/etc/hosts", contents: `${dockerBlockedHosts}\n`, append: true, mode: "0644" });
  return files.map(({ path, contents, append, mode }) => `  - path: ${path}\n    owner: root:root\n    permissions: '${mode ?? "0444"}'\n${append ? "    append: true\n" : ""}    content: |\n${contents.trimEnd().split("\n").map((line) => `      ${line}\n`).join("")}`).join("");
}
async function publicJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const metadata = await handle.stat(); if (!metadata.isFile() || metadata.size > 65536) throw new Error("cache catalog must be a bounded regular file"); const buffer = Buffer.alloc(65537); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); if (bytesRead > 65536) throw new Error("cache catalog exceeds byte limit"); return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); }
  finally { await handle.close(); }
}
export async function discoverVmCaches(environment: NodeJS.ProcessEnv = process.env): Promise<{ source: "explicit" | "workspace" | "direct"; endpoints: VmCacheEndpoints }> {
  if (environment.DIM_EXAMPLES_CACHE_CATALOG !== undefined) return { source: "explicit", endpoints: selectedCacheEndpoints(await publicJson(resolve(environment.DIM_EXAMPLES_CACHE_CATALOG))) };
  const file = join(environment.HOME ?? homedir(), ".local/state/dim/host-mirrors/active-clients.json");
  try { return { source: "workspace", endpoints: selectedCacheEndpoints(await publicJson(file), true) }; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return { source: "direct", endpoints: {} }; throw error; }
}
export function dockerCacheConfig(current: unknown, endpoints: VmCacheEndpoints): Record<string, unknown> {
  const config = object(current);
  if (!endpoints.docker) return config;
  if (Object.hasOwn(config, "registry-mirrors") || Object.hasOwn(config, "insecure-registries")) throw new Error("bootstrap refuses pre-existing Docker cache policy");
  return { ...config, "registry-mirrors": [endpoints.docker], ...(new URL(endpoints.docker).protocol === "http:" ? { "insecure-registries": [new URL(endpoints.docker).host] } : {}) };
}
async function main() {
  const [command, file, output, evidence] = process.argv.slice(2);
  if (command === "prepare" && file && output && evidence) {
    const selected = await discoverVmCaches();
    await writeFile(file, JSON.stringify({ schemaVersion: 1, endpoints: selected.endpoints }), { mode: 0o600, flag: "wx" });
    await writeFile(output, cacheCloudInit(selected.endpoints), { mode: 0o600, flag: "wx" });
    await writeFile(evidence, JSON.stringify(selected, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(`[examples] cache source=${selected.source} clients=${Object.keys(selected.endpoints).join(",") || "direct"}; no cache servers are provisioned`);
    return;
  }
  if (command === "docker-config" && file && output) {
    if (process.getuid?.() !== 0) throw new Error("Docker bootstrap cache configuration requires root");
    const endpoints = selectedCacheEndpoints(await publicJson(file)); if (!endpoints.docker) return;
    const metadata = await lstat(output);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0 || metadata.nlink !== 1 || (metadata.mode & 0o022) !== 0) throw new Error("unsafe bootstrap Docker configuration");
    const next = dockerCacheConfig(JSON.parse(await readFile(output, "utf8")), endpoints);
    await writeFile(output, JSON.stringify(next) + "\n", { mode: 0o644 });
    // cloud-init can regenerate /etc/hosts after write_files. Re-establish the
    // selected mirror's fallback boundary before the daemon is restarted.
    const hosts = await readFile("/etc/hosts", "utf8");
    if (!hosts.split("\n").includes(dockerBlockedHosts)) await writeFile("/etc/hosts", `${hosts.trimEnd()}\n${dockerBlockedHosts}\n`);
    console.log("configured"); return;
  }
  throw new Error("usage: vm-cache.ts prepare CATALOG CLOUD_INIT EVIDENCE | docker-config CATALOG DAEMON_CONFIG");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
