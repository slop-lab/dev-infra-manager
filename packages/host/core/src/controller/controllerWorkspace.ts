import os from "node:os";
import path from "node:path";
import { UserError, WorkspaceStore,
  type WorkspaceRecord, type WorkspaceRuntime } from "@slop-lab/dim-host-core/workspace";
import type { ControllerWorkspace, ResolvedWorkspaceTarget, WorkspaceTarget } from "./controller.js";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import { WorkspaceGrantStore } from "./workspaceGrantStore.js";

export function controllerWorkspaceStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.DIM_STATE_ROOT ?? path.join(os.homedir(), ".local/state/dim"));
}

export async function requireControllerWorkspace(workspace: ControllerWorkspace, stateRoot = controllerWorkspaceStateRoot()): Promise<WorkspaceRecord> {
  const record = await new WorkspaceStore(stateRoot).read(workspace.name);
  if (record.id !== workspace.id || !record.initialized || record.phase === "discarding") throw new UserError("workspace plugin identity is no longer current");
  return record;
}

/** Optional plugin operations observe core records; they never own workspace lifecycle. */
export type ControllerWorkspaceMetadataResolver = (record: WorkspaceRecord) => Promise<{ projectId: string; projectName: string } | undefined>;

export interface ControllerWorkspaceOptions extends Pick<LifecycleOptions, "stateRoot"> {
  readonly workspaceRuntime?: WorkspaceRuntime;
}

export class ControllerWorkspaces {
  readonly store: WorkspaceStore;
  private readonly grants: WorkspaceGrantStore;
  private readonly runtime: WorkspaceRuntime | undefined;
  constructor(lifecycle: ControllerWorkspaceOptions, stateRoot = controllerWorkspaceStateRoot(),
    private readonly metadata?: ControllerWorkspaceMetadataResolver) {
    this.store = new WorkspaceStore(stateRoot);
    this.grants = new WorkspaceGrantStore(lifecycle.stateRoot);
    this.runtime = lifecycle.workspaceRuntime;
  }

  async ensureGrant(name: string, expectedWorkspaceId?: string): Promise<string> {
    return this.store.withLock(name, async () => {
      const record = await this.store.read(name);
      if (expectedWorkspaceId !== undefined && record.id !== expectedWorkspaceId) throw new UserError("workspace plugin identity changed");
      if (!record.initialized || record.phase === "discarding") throw new UserError(`workspace '${name}' is unavailable for plugins`);
      return this.grants.ensure(record);
    });
  }
  async authenticate(token: string): Promise<ControllerWorkspace | undefined> {
    const record = await this.grants.authenticate(token, (name) => this.store.read(name));
    return record ? this.describe(record) : undefined;
  }
  async list(): Promise<ControllerWorkspace[]> {
    const records = await this.store.list();
    return Promise.all(records.filter((record) => record.initialized && record.phase !== "discarding").map((record) => this.describe(record)));
  }
  async run<T>(workspace: ControllerWorkspace, operation: () => Promise<T>): Promise<T> {
    return this.store.withLock(workspace.name, async () => { await this.current(workspace); return operation(); });
  }
  async resolveTarget(workspace: ControllerWorkspace, target: WorkspaceTarget): Promise<ResolvedWorkspaceTarget> {
    validateTarget(target);
    const record = await this.current(workspace);
    if (!this.runtime?.resolveTarget) throw new UserError(`workspace runtime '${record.runtime}' does not support controller targets`);
    const resolved = await this.runtime.resolveTarget(record, target);
    await this.current(workspace);
    return resolved;
  }
  private async current(workspace: ControllerWorkspace): Promise<WorkspaceRecord> {
    return requireControllerWorkspace(workspace, this.store.root);
  }
  private async describe(record: WorkspaceRecord): Promise<ControllerWorkspace> {
    const base = { id: record.id, name: record.name };
    const metadata = await this.metadata?.(record);
    return metadata === undefined ? base : { ...base, projectId: metadata.projectId, projectName: metadata.projectName };
  }
}
function validateTarget(target: WorkspaceTarget): void {
  if (!target || !Array.isArray(target.containers) || target.containers.length > 1
    || target.containers.some((name) => typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name))) {
    throw new UserError("target.containers must contain zero or one workspace container name");
  }
  if (!Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65535) throw new UserError("target.port must be between 1 and 65535");
  if (!["http", "https", "tcp"].includes(target.protocol)) throw new UserError("target.protocol must be http, https or tcp");
}
