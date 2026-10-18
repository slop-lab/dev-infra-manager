import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { MissingRecordError, UserError, acquireLifecycleLock, atomicWrite, listRecords, readJson,
  validateLifecycleName, type LifecycleLockOptions } from "@slop-lab/dim-core";
import type { ProjectRecord } from "./lifecycleTypes.js";
import { parseProjectRecord } from "./projectRecord.js";
import { parseHostMirrorOwnership, type HostMirrorOwnership } from "./hostMirrorOwnership.js";

export { validateLifecycleName } from "@slop-lab/dim-core";

/** Optional Project and host-service state; workspace records belong only to core. */
export class LifecycleState {
  constructor(readonly root: string, private readonly lockOptions: LifecycleLockOptions = {}) {}

  projectPath(name: string): string {
    return path.join(this.root, "projects", `${validateLifecycleName(name, "project")}.json`);
  }
  hostMirrorOwnershipPath(): string { return path.join(this.root, "services", "host-mirrors.json"); }
  async readHostMirrorOwnership(): Promise<HostMirrorOwnership | undefined> {
    try { return parseHostMirrorOwnership(await readJson<unknown>(this.hostMirrorOwnershipPath(), "host mirror ownership state not found")); }
    catch (error) { if (error instanceof MissingRecordError) return undefined; throw error; }
  }
  async writeHostMirrorOwnership(record: HostMirrorOwnership): Promise<void> { await atomicWrite(this.hostMirrorOwnershipPath(), record); }
  async acquireRegistryCacheLock(): Promise<() => Promise<void>> {
    return acquireLifecycleLock({ root: this.root, name: "registry-cache", description: "registry cache reconciliation", options: this.lockOptions });
  }
  async acquireQemuProjectHookPublicationLock(projectId: string): Promise<() => Promise<void>> {
    if (!/^[A-Za-z0-9-]+$/.test(projectId)) throw new UserError(`project ID '${projectId}' is invalid`);
    return acquireLifecycleLock({ root: this.root, name: `qemu-project-hook-${projectId}`, description: `QEMU Project hook '${projectId}' publication`, options: this.lockOptions });
  }
  async claimProject(record: ProjectRecord): Promise<void> {
    const target = this.projectPath(record.name);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      const handle = await open(target, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8"); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new UserError(`project '${record.name}' already exists`);
      throw error;
    }
  }
  async writeProject(record: ProjectRecord): Promise<void> { await atomicWrite(this.projectPath(record.name), record); }
  async readProject(name: string): Promise<ProjectRecord> {
    return parseProjectRecord(await readJson<unknown>(this.projectPath(name), `project '${name}' not found`));
  }
  async listProjects(): Promise<ProjectRecord[]> {
    return (await listRecords<ProjectRecord>(path.join(this.root, "projects"), "project", 6)).map(parseProjectRecord);
  }
  async removeProject(name: string): Promise<void> { await rm(this.projectPath(name), { force: true }); }
  async acquireProjectLock(name: string): Promise<() => Promise<void>> {
    return acquireLifecycleLock({ root: this.root, name: `project-${validateLifecycleName(name, "project")}`, description: `Project '${name}' reconciliation`, options: this.lockOptions });
  }
}
