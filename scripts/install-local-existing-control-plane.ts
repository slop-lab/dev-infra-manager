/** Development-only host installation selection; the remote control plane is never deployed here. */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { removalPaths } from "./local-uninstall/paths.ts";
import { privateDirectory, privateJson, replaceJson } from "./local-control-plane/files.ts";
import { readExistingConnections, attestExistingConnections, type ExistingConnections } from "./local-control-plane/existing-connections.ts";
import { existingSshArguments, existingSshTransport } from "./local-control-plane/existing-ssh.ts";
export interface ExistingControlPlaneSelection { schemaVersion: 1; connections: string; ssh?: string }
export interface ExistingControlPlaneOperations {
  attest(bundle: ExistingConnections): Promise<void>;
  temporary<T>(alias: string, bundle: ExistingConnections, action: () => Promise<T>): Promise<T>;
  persist(alias: string, bundle: ExistingConnections): Promise<void>;
  select(directory: string): Promise<void>;
}
export async function readExistingControlPlaneSelection(env: NodeJS.ProcessEnv = process.env): Promise<ExistingControlPlaneSelection | undefined> {
  const value = await privateJson(join(removalPaths(env).configuration, "existing-control-plane/selection.json"));
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid existing control-plane selection");
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || typeof row.connections !== "string" || !isAbsolute(row.connections) || row.ssh !== undefined && (typeof row.ssh !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,252}$/.test(row.ssh)) || Object.keys(row).some((key) => !["schemaVersion", "connections", "ssh"].includes(key))) throw new Error("invalid existing control-plane selection");
  return { schemaVersion: 1, connections: row.connections, ...(typeof row.ssh === "string" ? { ssh: row.ssh } : {}) };
}
async function installedSelect(directory: string, env: NodeJS.ProcessEnv): Promise<void> {
  const selectedEnvironment = { ...env };
  for (const key of ["DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE", "DIM_NATIVE_ROOT_IMPORTER_CONNECTION_FILE", "DIM_NATIVE_GIT_SYNC_CONNECTION_FILE"]) delete selectedEnvironment[key];
  const require = createRequire(join(removalPaths(env).hostPlugins, "package.json"));
  const native = await import(pathToFileURL(require.resolve("@slop-lab/dim-host-plugin-native-git")).href) as typeof import("../packages/host/plugins/native-git/src/index.js");
  await native.saveControlPlaneSelection({ hostConnectionFile: join(directory, "host.json"), importerConnectionFile: join(directory, "importer.json") }, selectedEnvironment);
  console.log(`[install] reconnected ${await native.reconnectNativeWorkspaces(selectedEnvironment)} existing workspace Git brokers`);
}
export async function installLocalExistingControlPlane(input: { connections: string; ssh?: string; check?: boolean }, env: NodeJS.ProcessEnv = process.env, overrides: Partial<ExistingControlPlaneOperations> = {}): Promise<ExistingControlPlaneSelection> {
  const bundle = await readExistingConnections(input.connections);
  if (input.ssh !== undefined) existingSshArguments(input.ssh, bundle);
  const transport = input.ssh === undefined ? undefined : existingSshTransport(env);
  const ops: ExistingControlPlaneOperations = { attest: attestExistingConnections,
    temporary: transport?.temporary ?? (async (_alias, _bundle, action) => action()),
    persist: transport?.persist ?? (async () => {}), select: (directory) => installedSelect(directory, env), ...overrides };
  const attest = () => ops.attest(bundle);
  if (input.ssh !== undefined) await ops.temporary(input.ssh, bundle, attest); else await attest();
  if (input.check) {
    console.log(`[install] existing control-plane connections verified: host ${bundle.hostId}, generation ${bundle.generationId}`);
    return { schemaVersion: 1, connections: input.connections, ...(input.ssh ? { ssh: input.ssh } : {}) };
  }
  const root = join(removalPaths(env).configuration, "existing-control-plane");
  await privateDirectory(root);
  const directory = join(root, `connections-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  for (const [name, value] of Object.entries(bundle.files)) await writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  if (input.ssh !== undefined) await ops.persist(input.ssh, bundle);
  // Re-attest after the durable tunnel is running and immediately before selecting credentials.
  await ops.attest(await readExistingConnections(directory));
  await ops.select(directory);
  const selected: ExistingControlPlaneSelection = { schemaVersion: 1, connections: directory, ...(input.ssh ? { ssh: input.ssh } : {}) };
  await replaceJson(join(root, "selection.json"), selected);
  console.log(`[install] selected existing control plane for ${bundle.hostId}; local service deployment skipped`);
  return selected;
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const parsed = parseArgs({ options: { connections: { type: "string" }, "control-plane-ssh": { type: "string" }, check: { type: "boolean", default: false }, saved: { type: "boolean", default: false } }, allowPositionals: false });
  if (parsed.values.saved && (parsed.values.connections !== undefined || parsed.values["control-plane-ssh"] !== undefined)) throw new Error("--saved cannot be combined with explicit connections or SSH selection");
  const saved = parsed.values.saved ? await readExistingControlPlaneSelection() : undefined;
  const connections = saved?.connections ?? parsed.values.connections;
  if (!connections) throw new Error("Usage: node scripts/install-local-existing-control-plane.ts [--check] (--saved | --connections ABSOLUTE_DIR [--control-plane-ssh SSH_ALIAS])");
  const ssh = saved?.ssh ?? parsed.values["control-plane-ssh"];
  await installLocalExistingControlPlane({ connections, ...(ssh !== undefined ? { ssh } : {}), check: parsed.values.check });
}
