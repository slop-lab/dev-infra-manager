import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { LifecycleState, UserError, type WorkspaceTarget } from "@slop-lab/dim-core";

const HOST_URL_LIST_LIMIT = 1_000;

export interface ExternalRoute {
  id: string;
  ingress: string;
  authority: string;
  ingressId?: string;
  url?: string;
}

export interface StoredUrl {
  id: string;
  workspace: string;
  workspaceId: string;
  ingress: string;
  subdomain?: string;
  target: WorkspaceTarget;
  path?: string;
  route: ExternalRoute;
  url: string;
  createdAt: string;
}

export class ExternalUrlStore {
  constructor(readonly stateRoot: string) {}

  async list(workspaceId: string, maximumEntries?: number): Promise<StoredUrl[]> {
    const directory = this.directory(workspaceId);
    try {
      const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
      if (maximumEntries !== undefined && names.length > maximumEntries) {
        throw new UserError(`host external URL listing exceeds its ${HOST_URL_LIST_LIMIT}-route limit`);
      }
      return await Promise.all(names.map(async (name) => {
        const value = JSON.parse(await readFile(path.join(directory, name), "utf8")) as unknown;
        return storedUrl(value);
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async put(entry: StoredUrl): Promise<void> {
    const target = this.entryPath(entry.workspaceId, entry.id);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  async remove(entry: StoredUrl): Promise<void> {
    await rm(this.entryPath(entry.workspaceId, entry.id), { force: true });
  }

  async removeIngress(ingress: string): Promise<void> {
    const root = path.join(this.stateRoot, "plugins", "external-urls");
    let workspaces: string[];
    try {
      workspaces = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const workspace of workspaces) {
      const directory = path.join(root, workspace);
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
        throw error;
      }
      for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
        const target = path.join(directory, name);
        const entry = storedUrl(JSON.parse(await readFile(target, "utf8")) as unknown);
        if (entry.ingress === ingress) await rm(target, { force: true });
      }
    }
  }

  private directory(workspaceId: string): string {
    return path.join(this.stateRoot, "plugins", "external-urls", Buffer.from(workspaceId).toString("base64url"));
  }

  private entryPath(workspaceId: string, id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new UserError("invalid external URL id");
    return path.join(this.directory(workspaceId), `${id}.json`);
  }
}

export async function hostUrlList(stateRoot: string): Promise<{ readonly urls: readonly Record<string, unknown>[] }> {
  const store = new ExternalUrlStore(stateRoot);
  const workspaces = await new LifecycleState(stateRoot).listWorkspaces();
  const urls: Record<string, unknown>[] = [];
  for (const workspace of workspaces.sort((left, right) =>
    left.projectName.localeCompare(right.projectName) || left.name.localeCompare(right.name))) {
    const entries = await store.list(workspace.workspaceId, HOST_URL_LIST_LIMIT - urls.length);
    urls.push(...entries.map((entry) => hostEntry(entry, workspace.projectName, workspace.name)));
  }
  return { urls };
}

export function publicEntries(entries: readonly StoredUrl[]): readonly Record<string, unknown>[] {
  return entries.map(publicEntry);
}

export function publicEntry({ route: _route, workspaceId: _workspaceId, ...entry }: StoredUrl) {
  return entry;
}

export function deduplicateRoutes(entries: readonly StoredUrl[]): StoredUrl[] {
  return [...new Map(entries.map((entry) => [entry.route.id, entry])).values()];
}

function hostEntry(
  { route: _route, workspaceId: _workspaceId, workspace: _workspace, ...entry }: StoredUrl,
  project: string,
  workspace: string
): Record<string, unknown> {
  return { project, workspace, ...entry };
}

function storedUrl(value: unknown): StoredUrl {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid stored external URL");
  }
  const candidate = value as StoredUrl;
  if (typeof candidate.ingress !== "string"
    || (candidate.subdomain !== undefined && typeof candidate.subdomain !== "string")
    || typeof candidate.route?.ingress !== "string") {
    throw new Error(`invalid stored external URL '${candidate.id}'`);
  }
  return candidate;
}
