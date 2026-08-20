import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { UserError } from "./errors.js";
import type { CiRunnerRecord, GiteaServiceRecord, ProjectRecord, WorkspaceRecord } from "./lifecycleTypes.js";

export function validateLifecycleName(value: string, kind: string): string {
  if (!/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(value)) {
    throw new UserError(`${kind} name must match [a-z0-9][a-z0-9_.-]{0,47}`);
  }
  return value;
}

export class LifecycleState {
  constructor(readonly root: string) {}

  projectPath(name: string): string {
    return path.join(this.root, "projects", `${validateLifecycleName(name, "project")}.json`);
  }

  workspacePath(name: string): string {
    return path.join(this.root, "workspaces", `${validateLifecycleName(name, "workspace")}.json`);
  }

  workspaceGrantPath(name: string): string {
    return path.join(this.root, "workspace-grants", validateLifecycleName(name, "workspace"));
  }

  async ensureWorkspaceGrant(name: string): Promise<string> {
    const workspace = validateLifecycleName(name, "workspace");
    const target = this.workspaceGrantPath(workspace);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      return (await readFile(target, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const token = `${workspace}.${randomBytes(32).toString("base64url")}`;
    try {
      const handle = await open(target, "wx", 0o600);
      await handle.writeFile(`${token}\n`, "utf8");
      await handle.close();
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return (await readFile(target, "utf8")).trim();
      throw error;
    }
  }

  async authenticateWorkspaceGrant(token: string): Promise<WorkspaceRecord | undefined> {
    const separator = token.indexOf(".");
    if (separator < 1) return undefined;
    const name = token.slice(0, separator);
    try {
      validateLifecycleName(name, "workspace");
      const expected = (await readFile(this.workspaceGrantPath(name), "utf8")).trim();
      const actualBuffer = Buffer.from(token);
      const expectedBuffer = Buffer.from(expected);
      if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return undefined;
      return await this.readWorkspace(name);
    } catch {
      return undefined;
    }
  }

  async removeWorkspaceGrant(name: string): Promise<void> {
    await rm(this.workspaceGrantPath(name), { force: true });
  }

  giteaServicePath(): string {
    return path.join(this.root, "services", "gitea.json");
  }

  ciRunnerPath(project: string): string {
    return path.join(this.root, "ci-runners", `${validateLifecycleName(project, "project")}.json`);
  }

  async readCiRunner(project: string): Promise<CiRunnerRecord> {
    const record = await readJson<CiRunnerRecord>(
      this.ciRunnerPath(project),
      `CI runner for project '${project}' not found`
    );
    assertSchemaVersion(record, "CI runner", project, 2);
    return record;
  }

  async writeCiRunner(record: CiRunnerRecord): Promise<void> {
    await atomicWrite(this.ciRunnerPath(record.projectName), record);
  }

  async removeCiRunner(project: string): Promise<void> {
    await rm(this.ciRunnerPath(project), { force: true });
  }

  async listCiRunners(): Promise<CiRunnerRecord[]> {
    return listRecords<CiRunnerRecord>(path.join(this.root, "ci-runners"), "CI runner", 2);
  }

  async acquireCiRunnerLock(project: string): Promise<() => Promise<void>> {
    return acquireLock(this.root, `ci-runner-${validateLifecycleName(project, "project")}`, `CI runner '${project}' reconciliation`);
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
    const raw = await readJson<WorkspaceRecord>(
      this.workspacePath(name),
      `workspace '${name}' not found`
    );
    assertSchemaVersion(raw, "workspace", name);
    return raw;
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

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    return listRecords<WorkspaceRecord>(path.join(this.root, "workspaces"), "workspace", 3);
  }

  async claimProject(record: ProjectRecord): Promise<void> {
    const target = this.projectPath(record.name);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      const handle = await open(target, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new UserError(`project '${record.name}' already exists`);
      }
      throw error;
    }
  }

  async writeProject(record: ProjectRecord): Promise<void> {
    await atomicWrite(this.projectPath(record.name), record);
  }

  async readProject(name: string): Promise<ProjectRecord> {
    const record = await readJson<ProjectRecord>(this.projectPath(name), `project '${name}' not found`);
    assertSchemaVersion(record, "project", name);
    return record;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return listRecords<ProjectRecord>(path.join(this.root, "projects"), "project", 3);
  }

  async removeProject(name: string): Promise<void> {
    await rm(this.projectPath(name), { force: true });
  }

  async acquireProjectLock(name: string): Promise<() => Promise<void>> {
    return acquireLock(this.root, `project-${validateLifecycleName(name, "project")}`, `project '${name}' reconciliation`);
  }
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

async function listRecords<T extends { schemaVersion: number; name: string }>(
  directory: string,
  kind: string,
  expectedSchemaVersion: number
): Promise<T[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(entries.filter((entry) => entry.endsWith(".json")).map(async (entry) => {
    const record = await readJson<T>(path.join(directory, entry), `invalid ${kind} record: ${entry}`);
    assertSchemaVersion(record, kind, record.name, expectedSchemaVersion);
    return record;
  }));
  return records.sort((left, right) => left.name.localeCompare(right.name));
}

function assertSchemaVersion(
  record: { schemaVersion?: number },
  kind: string,
  name: string,
  expected = 3
): void {
  if (record.schemaVersion !== expected) {
    throw new UserError(
      `${kind} '${name}' uses unsupported state schema ${String(record.schemaVersion)}; `
      + `expected ${expected} and DIM does not migrate existing state`
    );
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
