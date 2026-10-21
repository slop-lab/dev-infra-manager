import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { metadata, object, readJson, text } from "./files.ts";
import { inside, removalDirectories } from "./paths.ts";
import { selectedSharedIngressEdge } from "./shared-ingress-edge.ts";
import type { DockerResource } from "./docker.ts";
import type { RemovalPaths } from "./types.ts";

export interface PersistentData { readonly files: readonly string[]; readonly volumes: readonly string[] }
/** Authentication, service configuration and TLS state survive a local runtime replacement. */
export async function retainedPersistentData(paths: RemovalPaths, registeredConfigs: readonly string[] = [], resources: readonly DockerResource[] = []): Promise<PersistentData> {
  const edge = await selectedSharedIngressEdge(paths);
  const files = new Set<string>(), visited = new Set<string>(), removalRoots = removalDirectories(paths);
  let count = 0;
  async function retain(input: unknown): Promise<void> {
    const path = resolve(text(input));
    if (!isAbsolute(text(input))) throw new Error("persistent service paths must be absolute");
    if (!removalRoots.some((root) => inside(path, root))) return; // External operator data is already outside removal.
    if (removalRoots.some((root) => inside(root, path))) throw new Error(`persistent service path overlaps an installation root: ${path}`);
    const stat = await metadata(path);
    if (!stat) return;
    if (stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error(`unsafe persistent service path: ${path}`);
    files.add(path);
  }
  async function config(file: string): Promise<void> {
    const absolute = resolve(file);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    const input = await readJson(absolute);
    if (input === undefined) return;
    const row = object(input);
    if (row.schemaVersion === 3 && Array.isArray(row.accounts) && Array.isArray(row.hostIssuers) && row.backend !== undefined) {
      await retain(absolute); await retain(row.stateDirectory);
      if (row.accountManagement !== undefined) {
        const executable = text(object(row.accountManagement).backendExecutable);
        const binary = await metadata(executable);
        if (binary && (!binary.isFile() || binary.isSymbolicLink() || ![0, process.getuid?.()].includes(binary.uid) || (binary.mode & 0o022) !== 0 || (binary.mode & 0o111) === 0)) throw new Error("unsafe configured LLM account backend executable");
        await retain(executable);
      }
      for (const value of row.accounts) {
        const account = object(value);
        await retain(account.keyFile);
        if (account.credentialDirectory !== undefined) await retain(account.credentialDirectory);
      }
      for (const value of row.hostIssuers) await retain(object(value).keyFile);
      if (Array.isArray(row.operators)) for (const value of row.operators) await retain(object(value).keyFile);
    } else if (row.schemaVersion === 1 && row.connection !== undefined && row.workspaceStateRoot !== undefined) {
      await retain(absolute); await retain(row.stateDirectory);
      await retain(object(row.connection).issuerKeyFile);
    } else if (row.schemaVersion === 1 && Array.isArray(row.plugins)) {
      for (const raw of row.plugins) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const plugin = object(raw);
        if (plugin.package === "@slop-lab/dim-control-plane-plugin-llm-router") {
          const selected = text(plugin.config);
          if (!isAbsolute(selected)) throw new Error("registered router configuration must be absolute");
          await config(selected);
          await retain(absolute);
        }
      }
    }
  }
  async function scan(directory: string, depth: number): Promise<void> {
    const stat = await metadata(directory);
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error(`unsafe service configuration directory: ${directory}`);
    if (depth > 6) throw new Error("service configuration discovery exceeds its depth bound");
    const serviceDirectory = files.has(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 2048) throw new Error("service configuration discovery exceeds its entry bound");
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && !serviceDirectory) await scan(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".json")
        && (!serviceDirectory || ["router.json", "gateway.json", "config.json"].includes(entry.name))) await config(path);
    }
  }
  for (const root of new Set([paths.configuration, paths.data, paths.state, paths.managed, paths.controlPlane])) {
    for (const name of ["llm", "llm-host", "llm-router", "llm-backend", "tailscale"]) await retain(join(root, name));
    for (const name of ["llm-router", "tailscale"]) await retain(join(root, "plugins", name));
  }
  for (const root of new Set([paths.configuration, paths.state])) await retain(join(root, "shared-ingress"));
  await retain(join(paths.configuration, "external-urls.json"));
  if (edge) await retain(edge.directory);
  // Only private service configuration, never workspace checkouts or arbitrary source trees.
  await scan(paths.configuration, 0);
  for (const file of registeredConfigs) await config(file);
  const volumes = resources.filter(({ claim }) => {
    if (claim.kind !== "volume") return false;
    const edgeTls = edge && edge.volumes.includes(claim.name) && claim.requiresContainer === edge.container
      && claim.labels["com.docker.compose.project"] === edge.name
      && ["caddy-data", "caddy-config"].includes(claim.labels["com.docker.compose.volume"] ?? "");
    const tailscaleAuth = claim.labels["dim.managed"] === "true" && claim.labels["dim.owner"] === "dim"
      && claim.labels["dim.resource"] === "auth"
      && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(claim.labels["dim.tailscale-id"] ?? "");
    return edgeTls || tailscaleAuth;
  }).map(({ claim }) => claim.name);
  return { files: [...files].filter((file) => ![...files].some((parent) => parent !== file && inside(file, parent))).sort(), volumes };
}
