import { mkdir, open, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { MissingRecordError, UserError } from "./errors.js";
import { assertCiRunnerRecord } from "./ciRunnerRecord.js";
import { parseHostLifecycleRecord } from "./hostLifecycleRecord.js";
import { parseGiteaServiceRecord } from "./giteaServiceRecord.js";
import { acquireLifecycleLock, type LifecycleLockOptions } from "./lifecycleLock.js";
import { atomicWrite, listRecords, readJson, validateLifecycleName } from "./lifecycleRecord.js";
import type { CiRunnerRecord, GiteaServiceRecord, HostLifecycleRecord, ProjectRecord, WorkspaceRecord } from "./lifecycleTypes.js";
import { parseProjectRecord } from "./projectRecord.js";
import { assertWorkspaceRecord } from "./workspaceRecord.js";
import { WorkspaceGrantStore } from "./workspaceGrantStore.js";

export { validateLifecycleName } from "./lifecycleRecord.js";

export class LifecycleState {
  private readonly grants: WorkspaceGrantStore;

  constructor(readonly root: string, private readonly lockOptions: LifecycleLockOptions = {}) {
    this.grants = new WorkspaceGrantStore(root);
  }

  projectPath(name: string): string {
    return path.join(this.root, "projects", `${validateLifecycleName(name, "project")}.json`);
  }

  workspacePath(name: string): string {
    return path.join(this.root, "workspaces", `${validateLifecycleName(name, "workspace")}.json`);
  }

  async ensureWorkspaceGrant(name: string): Promise<string> {
    return this.grants.ensure(await this.readWorkspace(name), "workspace");
  }

  async ensureAgentGrant(name: string): Promise<string> {
    return this.grants.ensure(await this.readWorkspace(name), "agent");
  }

  async readWorkspaceGrant(name: string): Promise<string> {
    return this.grants.read(await this.readWorkspace(name), "workspace");
  }

  async authenticateWorkspaceGrant(token: string): Promise<WorkspaceRecord | undefined> {
    return this.grants.authenticate(token, "workspace", (name) => this.readWorkspace(name));
  }

  async authenticateAgentGrant(token: string): Promise<WorkspaceRecord | undefined> {
    return this.grants.authenticate(token, "agent", (name) => this.readWorkspace(name));
  }

  async removeWorkspaceGrant(record: Pick<WorkspaceRecord, "name" | "workspaceId">): Promise<void> {
    await this.grants.remove(record, "workspace");
  }

  async removeAgentGrant(record: Pick<WorkspaceRecord, "name" | "workspaceId">): Promise<void> {
    await this.grants.remove(record, "agent");
  }

  giteaServicePath(): string {
    return path.join(this.root, "services", "gitea.json");
  }

  hostLifecyclePath(): string {
    return path.join(this.root, "host.json");
  }

  async readHostLifecycle(): Promise<HostLifecycleRecord | undefined> {
    try {
      const record = await readJson<unknown>(this.hostLifecyclePath(), "host lifecycle state not found");
      return parseHostLifecycleRecord(record);
    } catch (error) {
      if (error instanceof MissingRecordError) return undefined;
      throw error;
    }
  }

  async writeHostLifecycle(record: HostLifecycleRecord): Promise<void> {
    await atomicWrite(this.hostLifecyclePath(), record);
  }

  async acquireHostLifecycleLock(): Promise<() => Promise<void>> {
    return acquireLifecycleLock({ root: this.root, name: "host-lifecycle", description: "host lifecycle reconciliation", options: this.lockOptions });
  }

  async acquireRegistryCacheLock(): Promise<() => Promise<void>> { return acquireLifecycleLock({ root: this.root, name: "registry-cache", description: "registry cache reconciliation", options: this.lockOptions }); }

  async acquireGiteaServiceLock(): Promise<() => Promise<void>> { return acquireLifecycleLock({ root: this.root, name: "gitea-service", description: "Gitea service reconciliation", options: this.lockOptions }); }

  ciRunnerPath(project: string, name: string): string {
    return path.join(
      this.root,
      "ci-runners",
      validateLifecycleName(project, "project"),
      `${validateLifecycleName(name, "CI runner")}.json`
    );
  }

  async readCiRunner(project: string, name: string): Promise<CiRunnerRecord> {
    const record = await readJson<CiRunnerRecord>(
      this.ciRunnerPath(project, name),
      `CI runner '${project}/${name}' not found`
    );
    assertCiRunnerRecord(record, `${project}/${name}`);
    return record;
  }

  async writeCiRunner(record: CiRunnerRecord): Promise<void> {
    await atomicWrite(this.ciRunnerPath(record.projectName, record.name), record);
  }

  async removeCiRunner(project: string, name: string): Promise<void> {
    const target = this.ciRunnerPath(project, name);
    await rm(target, { force: true });
    try { await rmdir(path.dirname(target)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
        && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async listCiRunners(): Promise<CiRunnerRecord[]> {
    const directory = path.join(this.root, "ci-runners");
    let projects;
    try { projects = await readdir(directory, { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: CiRunnerRecord[] = [];
    for (const project of projects) {
      if (!project.isDirectory()) {
        throw new UserError("legacy CI runner state is unsupported; disable old runners before upgrading");
      }
      records.push(...await listRecords<CiRunnerRecord>(
        path.join(directory, project.name),
        "CI runner",
        8
      ));
    }
    return records.sort((left, right) =>
      left.projectName.localeCompare(right.projectName) || left.name.localeCompare(right.name));
  }

  async acquireCiRunnerLock(project: string): Promise<() => Promise<void>> {
    project = validateLifecycleName(project, "project");
    return acquireLifecycleLock({ root: this.root, name: `ci-runner-${project}`, description: `CI runners for project '${project}' reconciliation`, options: this.lockOptions });
  }

  async acquireQemuProjectHookPublicationLock(projectId: string): Promise<() => Promise<void>> {
    if (!/^[A-Za-z0-9-]+$/.test(projectId)) throw new UserError(`project ID '${projectId}' is invalid`);
    return acquireLifecycleLock({ root: this.root, name: `qemu-project-hook-${projectId}`, description: `QEMU Project hook '${projectId}' publication`, options: this.lockOptions });
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
    return parseGiteaServiceRecord(await readJson<unknown>(this.giteaServicePath(), "Gitea service state not found"));
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
    assertWorkspaceRecord(raw, this.workspacePath(name));
    return raw;
  }

  async removeWorkspace(name: string): Promise<void> {
    await rm(this.workspacePath(name), { force: true });
  }

  async acquireWorkspaceLock(name: string): Promise<() => Promise<void>> {
    return acquireLifecycleLock({ root: this.root, name: `workspace-${validateLifecycleName(name, "workspace")}`, description: `workspace '${name}' reconciliation`, options: this.lockOptions });
  }

  async acquireWorkspaceSetupLock(name: string): Promise<() => Promise<void>> {
    return acquireLifecycleLock({ root: this.root, name: `workspace-${validateLifecycleName(name, "workspace")}-setup`, description: `workspace '${name}' setup`, options: this.lockOptions });
  }

  async acquireWorkspaceAuthorityLock(name: string): Promise<() => Promise<void>> {
    return acquireLifecycleLock({ root: this.root, name: `workspace-${validateLifecycleName(name, "workspace")}-authority`, description: `workspace '${name}' authority`, options: this.lockOptions });
  }

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    const records = await listRecords<WorkspaceRecord>(path.join(this.root, "workspaces"), "workspace", 8);
    for (const record of records) {
      assertWorkspaceRecord(record, this.workspacePath(record.name));
    }
    return records;
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
    return parseProjectRecord(await readJson<unknown>(this.projectPath(name), `project '${name}' not found`));
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return (await listRecords<ProjectRecord>(path.join(this.root, "projects"), "project", 4))
      .map((record) => parseProjectRecord(record));
  }

  async removeProject(name: string): Promise<void> {
    await rm(this.projectPath(name), { force: true });
  }

  async acquireProjectLock(name: string): Promise<() => Promise<void>> {
    return acquireLifecycleLock({ root: this.root, name: `project-${validateLifecycleName(name, "project")}`, description: `project '${name}' reconciliation`, options: this.lockOptions });
  }
}
