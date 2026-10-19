import path from "node:path";
import { acquireLifecycleLock,
  validateLifecycleName, type LifecycleLockOptions } from "@slop-lab/dim-core";

export { validateLifecycleName } from "@slop-lab/dim-core";

/** Optional Project and host-service state; workspace records belong only to core. */
export class LifecycleState {
  constructor(readonly root: string, private readonly lockOptions: LifecycleLockOptions = {}) {}

  projectPath(name: string): string {
    return path.join(this.root, "projects", `${validateLifecycleName(name, "project")}.json`);
  }
  async acquireProjectLock(name: string): Promise<() => Promise<void>> {
    return acquireLifecycleLock({ root: this.root, name: `project-${validateLifecycleName(name, "project")}`, description: `Project '${name}' reconciliation`, options: this.lockOptions });
  }
}
