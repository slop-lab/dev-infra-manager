import path from "node:path";
import { MissingRecordError, acquireLifecycleLock, atomicWrite, readJson,
  validateLifecycleName, type LifecycleLockOptions } from "@slop-lab/dim-core";
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
  async acquireProjectLock(name: string): Promise<() => Promise<void>> {
    return acquireLifecycleLock({ root: this.root, name: `project-${validateLifecycleName(name, "project")}`, description: `Project '${name}' reconciliation`, options: this.lockOptions });
  }
}
