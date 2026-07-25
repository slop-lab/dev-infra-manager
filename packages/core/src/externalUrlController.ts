import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createExternalUrlController,
  type ExternalUrlControllerOptions,
  type ExternalRouteProvider,
  type ExternalUrlStore,
  type ExternalUrlStoreEntry
} from "./externalUrls.js";
import { LifecycleState } from "./lifecycleState.js";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import type { RegisteredDimPlugins } from "./plugin.js";
import { ProcessRunner } from "./runner.js";

export class FileExternalUrlStore implements ExternalUrlStore {
  constructor(readonly root: string) {}

  async list(workspaceId: string): Promise<ExternalUrlStoreEntry[]> {
    const directory = this.directory(workspaceId);
    try {
      const names = await readdir(directory);
      return await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) =>
        JSON.parse(await readFile(path.join(directory, name), "utf8")) as ExternalUrlStoreEntry
      ));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async put(workspaceId: string, entry: ExternalUrlStoreEntry): Promise<void> {
    const target = this.entryPath(workspaceId, entry.id);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  async remove(workspaceId: string, id: string): Promise<ExternalUrlStoreEntry | undefined> {
    const target = this.entryPath(workspaceId, id);
    try {
      const entry = JSON.parse(await readFile(target, "utf8")) as ExternalUrlStoreEntry;
      await rm(target, { force: true });
      return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private directory(workspaceId: string): string {
    const safe = Buffer.from(workspaceId).toString("base64url");
    return path.join(this.root, "external-urls", safe);
  }

  private entryPath(workspaceId: string, id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid external URL id");
    return path.join(this.directory(workspaceId), `${id}.json`);
  }
}

export function configuredExternalUrlController(
  lifecycle: LifecycleOptions,
  plugins: RegisteredDimPlugins,
  overrides: Partial<Pick<ExternalUrlControllerOptions, "resolveUpstream" | "store">> = {}
) {
  const state = new LifecycleState(lifecycle.stateRoot);
  return createExternalUrlController({
    authenticate: async (token) => {
      const workspace = await state.authenticateWorkspaceGrant(token);
      return workspace && {
        id: `${workspace.projectId}:${workspace.name}`,
        name: workspace.name,
        projectId: workspace.projectId,
        projectName: workspace.projectName
      };
    },
    resolveUpstream: overrides.resolveUpstream ?? (async (workspace, request, routeProvider) => {
      const record = await state.readWorkspace(workspace.name);
      if (record.projectId !== workspace.projectId) throw new Error("workspace identity changed");
      let host = record.containerName;
      if (routeProvider.upstreamMode === "container-ip") {
        host = await containerNetworkIp(record.containerName, record.networkName);
      }
      return {
        protocol: request.protocol ?? "http",
        host,
        port: request.port
      };
    }),
    routeProviders: plugins.externalRouteProviders,
    urlProviders: plugins.externalUrlProviders,
    store: overrides.store ?? new FileExternalUrlStore(lifecycle.stateRoot)
  });
}

export async function reconcileExternalUrlRoutes(
  lifecycle: LifecycleOptions,
  plugins: RegisteredDimPlugins,
  store: ExternalUrlStore = new FileExternalUrlStore(lifecycle.stateRoot)
): Promise<void> {
  const state = new LifecycleState(lifecycle.stateRoot);
  for (const record of await state.listWorkspaces()) {
    const workspaceId = `${record.projectId}:${record.name}`;
    const entries = await store.list(workspaceId);
    const routes = new Map(entries.map((entry) => [entry.route.id, entry]));
    for (const entry of routes.values()) {
      const provider = plugins.externalRouteProviders.get(entry.route.provider);
      if (!provider) throw new Error(`external route provider '${entry.route.provider}' is not configured`);
      const provisioned = await provider.provision({
        workspace: {
          id: workspaceId,
          name: record.name,
          projectId: record.projectId,
          projectName: record.projectName
        },
        request: entry.request,
        upstream: {
          protocol: entry.request.protocol,
          host: provider.upstreamMode === "container-ip"
            ? await containerNetworkIp(record.containerName, record.networkName)
            : record.containerName,
          port: entry.request.port
        }
      });
      if (provisioned.authority !== entry.route.authority) {
        throw new Error(`external route provider '${provider.name}' changed authority during reconciliation`);
      }
    }
  }
}

async function containerNetworkIp(containerName: string, networkName: string): Promise<string> {
  const inspected = await new ProcessRunner().run("docker", [
    "container", "inspect", containerName,
    "--format", "{{json .NetworkSettings.Networks}}"
  ]);
  if (inspected.exitCode !== 0) throw new Error(`cannot inspect host-reachable IP for '${containerName}'`);
  const networks = JSON.parse(inspected.stdout) as Record<string, { IPAddress?: string }>;
  const host = networks[networkName]?.IPAddress ?? "";
  if (!host) throw new Error(`container '${containerName}' has no IP on network '${networkName}'`);
  return host;
}
