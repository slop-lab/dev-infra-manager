import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { UserError } from "./errors.js";
import type { GiteaServiceRecord, RepoRecord, WorkspaceRecord } from "./lifecycleTypes.js";

export function validateLifecycleName(value: string, kind: string): string {
  if (!/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(value)) {
    throw new UserError(`${kind} name must match [a-z0-9][a-z0-9_.-]{0,47}`);
  }
  return value;
}

export class LifecycleState {
  constructor(readonly root: string) {}

  repoPath(name: string): string {
    return path.join(this.root, "repos", `${validateLifecycleName(name, "repo")}.json`);
  }

  workspacePath(name: string): string {
    return path.join(this.root, "workspaces", `${validateLifecycleName(name, "workspace")}.json`);
  }

  giteaServicePath(): string {
    return path.join(this.root, "services", "gitea.json");
  }

  async claimGiteaService(record: GiteaServiceRecord): Promise<void> {
    const target = this.giteaServicePath();
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      const handle = await open(target, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new UserError("Gitea service state already exists");
      }
      throw error;
    }
  }

  async readGiteaService(): Promise<GiteaServiceRecord> {
    return readJson(this.giteaServicePath(), "Gitea service state not found");
  }

  async writeGiteaService(record: GiteaServiceRecord): Promise<void> {
    await atomicWrite(this.giteaServicePath(), record);
  }

  async claimWorkspace(record: WorkspaceRecord): Promise<void> {
    const target = this.workspacePath(record.name);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      const handle = await open(target, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new UserError(`workspace '${record.name}' already exists`);
      }
      throw error;
    }
  }

  async writeWorkspace(record: WorkspaceRecord): Promise<void> {
    await atomicWrite(this.workspacePath(record.name), record);
  }

  async readWorkspace(name: string): Promise<WorkspaceRecord> {
    const raw = await readJson<WorkspaceRecord & { repo?: string }>(
      this.workspacePath(name),
      `workspace '${name}' not found`
    );
    return normalizeWorkspaceRecord(raw);
  }

  async removeWorkspace(name: string): Promise<void> {
    await rm(this.workspacePath(name), { force: true });
  }

  async acquireWorkspaceLock(name: string): Promise<() => Promise<void>> {
    return acquireLock(this.root, `workspace-${validateLifecycleName(name, "workspace")}`, `workspace '${name}' reconciliation`);
  }

  async acquireWorkspaceSetupLock(name: string): Promise<() => Promise<void>> {
    return acquireLock(this.root, `workspace-${validateLifecycleName(name, "workspace")}-setup`, `workspace '${name}' setup`);
  }

  async claimRepo(record: RepoRecord): Promise<void> {
    const target = this.repoPath(record.name);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      const handle = await open(target, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new UserError(`repo '${record.name}' is already registered`);
      }
      throw error;
    }
  }

  async writeRepo(record: RepoRecord): Promise<void> {
    await atomicWrite(this.repoPath(record.name), record);
  }

  async readRepo(name: string): Promise<RepoRecord> {
    return readJson(this.repoPath(name), `repo '${name}' is not registered`);
  }

  async listRepos(): Promise<RepoRecord[]> {
    const directory = path.join(this.root, "repos");
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(entries.filter((entry) => entry.endsWith(".json")).map((entry) =>
      readJson<RepoRecord>(path.join(directory, entry), `invalid repo record: ${entry}`)
    ));
    return records.sort((left, right) => left.name.localeCompare(right.name));
  }
}

function normalizeWorkspaceRecord(raw: WorkspaceRecord & { repo?: string }): WorkspaceRecord {
  const project = raw.project ?? raw.repo;
  if (!project) throw new UserError(`workspace '${raw.name}' has no project`);
  const legacy = raw.project === undefined;
  const { repo: _legacyRepo, ...record } = raw;
  return {
    ...record,
    project,
    projectPath: raw.projectPath ?? (legacy ? `/workspace/repos/${project}` : "/workspace/project"),
    profiles: raw.profiles ?? [],
    composeProjectName: raw.composeProjectName ?? `dim-${raw.name}`,
    gitUserName: raw.gitUserName ?? `dim/${raw.name}`,
    gitUserEmail: raw.gitUserEmail ?? `${raw.name}@dim.invalid`,
    gitBaseUrl: raw.gitBaseUrl ?? "http://dim-gitea:3000"
  };
}

async function acquireLock(root: string, name: string, description: string): Promise<() => Promise<void>> {
    const lockPath = path.join(root, "locks", `${name}.lock`);
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
        await handle.close();
        return async () => {
          await rm(lockPath, { force: true });
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await lockIsStale(lockPath)) {
          await rm(lockPath, { force: true });
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new UserError(`timed out waiting for ${description} lock`);
}

async function atomicWrite(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

async function readJson<T>(target: string, missingMessage: string): Promise<T> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UserError(missingMessage);
    }
    throw error;
  }
}

async function lockIsStale(lockPath: string): Promise<boolean> {
  try {
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number; createdAt?: string };
    if (!Number.isSafeInteger(lock.pid) || !lock.pid) return true;
    const createdAt = Date.parse(lock.createdAt ?? "");
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > 5 * 60 * 1000) return true;
    try {
      process.kill(lock.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return true;
  }
}
