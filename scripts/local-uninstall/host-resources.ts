import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { jsonFiles, metadata, object, readJson, text, uuid } from "./files.ts";
import type { DockerClaim, RemovalPaths } from "./types.ts";

const identifier = /^[a-z0-9][a-z0-9-]{0,62}$/;
function named(value: unknown): string {
  const result = text(value);
  if (!identifier.test(result)) throw new Error(`invalid DIM resource name: ${result}`);
  return result;
}
function identity(value: unknown): string {
  const result = text(value);
  if (!/^[A-Za-z0-9_-]{43}$/.test(result)) throw new Error("invalid DIM cache ownership identity");
  return result;
}
async function directory(path: string): Promise<boolean> {
  const stat = await metadata(path);
  if (!stat) return false;
  for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
    const ancestor = await metadata(parent);
    if (!ancestor?.isDirectory() || ancestor.isSymbolicLink()) throw new Error(`unsafe DIM state ancestor: ${parent}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error(`unsafe DIM state directory: ${path}`);
  return true;
}
function roots(paths: RemovalPaths): string[] { return [...new Set([paths.state, paths.managed])]; }
async function records(root: string): Promise<Record<string, unknown>[]> {
  const selected = join(root, "workspaces");
  if (!await directory(selected)) return [];
  const result: Record<string, unknown>[] = [];
  for (const file of await jsonFiles(selected)) {
    const record = object(await readJson(file));
    if (record.schemaVersion !== 10 || basename(file) !== `${text(record.name)}.json`) throw new Error(`unsupported workspace state: ${file}`);
    uuid(record.id);
    if (record.runtime !== "container" && record.runtime !== "vm") throw new Error(`uninstall cannot safely remove workspace runtime '${text(record.runtime)}' in ${file}`);
    result.push(record);
  }
  return result;
}

/** Claims originate from this user's selected state, never from global Docker label discovery. */
export async function collectHostClaims(paths: RemovalPaths): Promise<DockerClaim[]> {
  const claims: DockerClaim[] = [];
  for (const root of roots(paths)) {
    if (!await directory(root)) continue;
    for (const record of await records(root)) {
      if (record.runtime === "vm") continue;
      const id = uuid(record.id), prefix = `dim-workspace-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
      for (const role of ["container", "network", "home", "checkout", "docker", "tmp"] as const) claims.push({
        kind: role === "container" || role === "network" ? role : "volume",
        name: role === "container" || role === "network" ? prefix : `${prefix}-${role}`,
        labels: { "dim.managed": "true", "dim.workspace-id": id, "dim.resource": role, "dim.workspace-schema": "10" }
      });
    }
    const services = join(root, "plugins", "cache-server", "services");
    if (await directory(services)) for (const file of await jsonFiles(services)) {
      const match = /^cache-([a-z][a-z0-9-]{0,31})\.json$/.exec(basename(file));
      if (!match) throw new Error(`unknown cache ownership state: ${file}`);
      const namespace = match[1]!, ledger = object(await readJson(file));
      if (ledger.schemaVersion !== 2) throw new Error(`unsupported cache ownership state: ${file}`);
      const service = identity(ledger.serviceId), resources = object(ledger.resourceIds);
      identity(resources.network);
      for (const [resource, rawId] of Object.entries(resources)) {
        const match = /^(cache|data):([a-z][a-z0-9-]{0,31})$/.exec(resource);
        if (resource !== "network" && !match) throw new Error(`unknown cache resource: ${resource}`);
        claims.push({ kind: resource === "network" ? "network" : match![1] === "cache" ? "container" : "volume",
          name: resource === "network" ? `${namespace}-network` : `${namespace}-${match![2]}${match![1] === "data" ? "-data" : ""}`,
          labels: { "dim.managed": "true", "dim.owner": "dim", "dim.service-id": service, "dim.resource": resource, "dim.resource-id": identity(rawId) } });
      }
    }
    const caddy = join(root, "plugins", "external-urls", "caddy");
    if (await directory(caddy)) for (const entry of await readdir(caddy)) {
      const name = named(entry), path = join(caddy, name);
      if (!await directory(path)) continue;
      const compose = join(path, "compose.yml"), stat = await metadata(compose);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.size > 1024 * 1024) throw new Error(`unsafe Caddy state: ${compose}`);
      const contents = await readFile(compose, "utf8");
      if (!contents.includes(`    container_name: dim-caddy-${name}\n`)) throw new Error(`unrecognized Caddy deployment: ${compose}`);
      claims.push({ kind: "container", name: `dim-caddy-${name}`, labels: {
        "com.docker.compose.project": name, "com.docker.compose.service": "caddy",
        "com.docker.compose.project.working_dir": path, "com.docker.compose.project.config_files": compose
      } });
      for (const volume of ["caddy-data", "caddy-config"]) {
        if (!contents.includes(`  ${volume}:\n`)) throw new Error(`unrecognized Caddy volume state: ${compose}`);
        claims.push({ kind: "volume", name: `${name}_${volume}`, requiresContainer: `dim-caddy-${name}`,
          labels: { "com.docker.compose.project": name, "com.docker.compose.volume": volume } });
      }
    }
  }
  return claims;
}

export interface VmClaim { readonly project: string; readonly name: string; readonly id: string; readonly image: string }
export async function collectVmClaims(paths: RemovalPaths): Promise<VmClaim[]> {
  const claims: VmClaim[] = [];
  for (const root of roots(paths)) {
    if (!await directory(root)) continue;
    const selected = (await records(root)).filter((record) => record.runtime === "vm");
    const instances = join(root, "plugins", "vm", "instances");
    if (await directory(instances)) for (const file of await jsonFiles(instances)) {
      const record = object(await readJson(file));
      if (record.schemaVersion !== 1 || basename(file) !== `${text(record.name)}.json`) throw new Error(`unsupported VM state: ${file}`);
      selected.push(record);
    }
    if (!selected.length) continue;
    const configurationDirectory = join(root, "plugins", "vm");
    if (!await directory(configurationDirectory)) throw new Error("VM removal requires its recorded host configuration");
    const config = object(await readJson(join(configurationDirectory, "config.json")));
    if (config.schemaVersion !== 1) throw new Error("unsupported VM host configuration");
    const project = named(config.project);
    for (const record of selected) {
      const id = uuid(record.id), image = text(record.image);
      if (!/^[0-9a-f]{64}$/.test(image)) throw new Error("VM removal requires its recorded exact image fingerprint");
      claims.push({ project, name: `dim-${id}`, id, image });
    }
  }
  return claims;
}
