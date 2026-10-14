import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { MissingRecordError, UserError } from "./errors.js";
import { parseHostLifecycleRecord } from "./hostLifecycleRecord.js";
import { acquireLifecycleLock, type LifecycleLockOptions } from "./lifecycleLock.js";
import { atomicWrite, listRecords, readJson, validateLifecycleName } from "./lifecycleRecord.js";
import type {
  HostLifecycleRecord,
  ProjectRecord,
  WorkspaceRecord
} from "./lifecycleTypes.js";
import { parseProjectRecord } from "./projectRecord.js";
import { assertWorkspaceRecord } from "./workspaceRecord.js";
import {
  parseHostMirrorOwnership,
  type HostMirrorOwnership
} from "./hostMirrorOwnership.js";
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

  async ensureNativeGitGrant(name: string): Promise<string> {
    return this.grants.ensure(await this.readWorkspace(name), "native-git");
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

  async authenticateNativeGitGrant(token: string): Promise<WorkspaceRecord | undefined> {
    return this.grants.authenticate(token, "native-git", (name) => this.readWorkspace(name));
  }

  async removeWorkspaceGrant(record: Pick<WorkspaceRecord, "name" | "workspaceId">): Promise<void> {
    await this.grants.remove(record, "workspace");
  }

  async removeAgentGrant(record: Pick<WorkspaceRecord, "name" | "workspaceId">): Promise<void> {
    await this.grants.remove(record, "agent");
  }

  async removeNativeGitGrant(record: Pick<WorkspaceRecord, "name" | "workspaceId">): Promise<void> {
    await this.grants.remove(record, "native-git");
  }

  hostLifecyclePath(): string {
    return path.join(this.root, "host.json");
  }

  hostMirrorOwnershipPath(): string {
    return path.join(this.root, "services", "host-mirrors.json");
  }

  async readHostMirrorOwnership(): Promise<HostMirrorOwnership | undefined> {
    try {
      return parseHostMirrorOwnership(await readJson<unknown>(
        this.hostMirrorOwnershipPath(),
        "host mirror ownership state not found"
      ));
    } catch (error) {
      if (error instanceof MissingRecordError) return undefined;
      throw error;
    }
  }

  async writeHostMirrorOwnership(record: HostMirrorOwnership): Promise<void> {
    await atomicWrite(this.hostMirrorOwnershipPath(), record);
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

  async acquireQemuProjectHookPublicationLock(projectId: string): Promise<() => Promise<void>> {
    if (!/^[A-Za-z0-9-]+$/.test(projectId)) throw new UserError(`project ID '${projectId}' is invalid`);
    return acquireLifecycleLock({ root: this.root, name: `qemu-project-hook-${projectId}`, description: `QEMU Project hook '${projectId}' publication`, options: this.lockOptions });
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
    const records = await listRecords<WorkspaceRecord>(
      path.join(this.root, "workspaces"),
      "workspace",
      9
    );
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
    return (await listRecords<ProjectRecord>(path.join(this.root, "projects"), "project", 6))
      .map((record) => parseProjectRecord(record));
  }

  async removeProject(name: string): Promise<void> {
    await rm(this.projectPath(name), { force: true });
  }

  async acquireProjectLock(name: string): Promise<() => Promise<void>> {
    return acquireLifecycleLock({ root: this.root, name: `project-${validateLifecycleName(name, "project")}`, description: `project '${name}' reconciliation`, options: this.lockOptions });
  }
}
