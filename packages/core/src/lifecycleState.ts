import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { MissingRecordError, UserError } from "./errors.js";
import { parseHostLifecycleRecord } from "./hostLifecycleRecord.js";
import { acquireLifecycleLock, type LifecycleLockOptions } from "./lifecycleLock.js";
import { assertSchemaVersion, assertSysboxWorkspace, atomicWrite, listRecords, readJson, validateLifecycleName } from "./lifecycleRecord.js";
import type { CiRunnerRecord, GiteaServiceRecord, HostLifecycleRecord, ProjectRecord, WorkspaceRecord } from "./lifecycleTypes.js";
import { parseProjectRecord } from "./projectRecord.js";
import { WORKSPACE_DATA } from "./workspaceLifecycleTypes.js";

export { validateLifecycleName } from "./lifecycleRecord.js";

export class LifecycleState {
  constructor(readonly root: string, private readonly lockOptions: LifecycleLockOptions = {}) {}

  projectPath(name: string): string {
    return path.join(this.root, "projects", `${validateLifecycleName(name, "project")}.json`);
  }

  workspacePath(name: string): string {
    return path.join(this.root, "workspaces", `${validateLifecycleName(name, "workspace")}.json`);
  }

  workspaceGrantPath(name: string): string {
    return path.join(this.root, "workspace-grants", validateLifecycleName(name, "workspace"));
  }

  agentGrantPath(name: string): string {
    return path.join(this.root, "agent-grants", validateLifecycleName(name, "workspace"));
  }

  async ensureWorkspaceGrant(name: string): Promise<string> {
    return this.ensureGrant(this.workspaceGrantPath(name), validateLifecycleName(name, "workspace"));
  }

  async ensureAgentGrant(name: string): Promise<string> {
    return this.ensureGrant(this.agentGrantPath(name), validateLifecycleName(name, "workspace"));
  }

  async authenticateWorkspaceGrant(token: string): Promise<WorkspaceRecord | undefined> {
    return this.authenticateGrant(token, (name) => this.workspaceGrantPath(name));
  }

  async authenticateAgentGrant(token: string): Promise<WorkspaceRecord | undefined> {
    return this.authenticateGrant(token, (name) => this.agentGrantPath(name));
  }

  private async ensureGrant(target: string, workspace: string): Promise<string> {
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

  private async authenticateGrant(
    token: string,
    pathFor: (name: string) => string
  ): Promise<WorkspaceRecord | undefined> {
    const separator = token.lastIndexOf(".");
    if (separator < 1) return undefined;
    const name = token.slice(0, separator);
    try {
      validateLifecycleName(name, "workspace");
      const expected = (await readFile(pathFor(name), "utf8")).trim();
      const actualBuffer = Buffer.from(token);
      const expectedBuffer = Buffer.from(expected);
      if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return undefined;
      return await this.readWorkspace(name);
    } catch {
      return undefined;
    }
  }

  async removeWorkspaceGrant(name: string): Promise<void> { await rm(this.workspaceGrantPath(name), { force: true }); }

  async removeAgentGrant(name: string): Promise<void> { await rm(this.agentGrantPath(name), { force: true }); }

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
    assertSchemaVersion(record, "CI runner", `${project}/${name}`, 8);
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
    assertSchemaVersion(raw, "workspace", name, 6);
    assertSysboxWorkspace(raw, name);
    assertWorkspaceContract(raw, name);
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

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    const records = await listRecords<WorkspaceRecord>(path.join(this.root, "workspaces"), "workspace", 6);
    for (const record of records) {
      assertSysboxWorkspace(record, record.name);
      assertWorkspaceContract(record, record.name);
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

function assertWorkspaceContract(record: WorkspaceRecord, name: string): void {
  if (Object.hasOwn(record, "repositorySnapshot") || Object.hasOwn(record, "repositoryRefOverrides")) {
    throw new UserError(`workspace '${name}' contains an obsolete repository catalog; export needed data and recreate the workspace`);
  }
  if (Object.hasOwn(record, "projectPath") || record.workspaceDataPath !== WORKSPACE_DATA) {
    throw new UserError(`workspace '${name}' has an invalid workspace data path; export needed data and recreate the workspace`);
  }
}
