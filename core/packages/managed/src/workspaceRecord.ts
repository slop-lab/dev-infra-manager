import { UserError } from "@slop-lab/dim-core";
import { assertSysboxWorkspace } from "@slop-lab/dim-core";
import type { WorkspaceRecord } from "./lifecycleTypes.js";

const WORKSPACE_DATA_PATH = "/var/lib/dim/workspace-data";

export function assertWorkspaceRecord(value: unknown, source: string): asserts value is WorkspaceRecord {
  if (!isRecord(value)) throw new UserError(`workspace state at '${source}' must be an object`);
  const name = typeof value.name === "string" ? value.name : source;
  if (value.schemaVersion !== 9) {
    throw new UserError(
      `workspace '${name}' uses unsupported predecessor state; use the prior pinned release to export needed data, then recreate the workspace`
    );
  }
  validateWorkspaceId(value.workspaceId, `workspace '${name}'`);
  assertSysboxWorkspace(value, name);
  if (Object.hasOwn(value, "rootSnapshotPath")) {
    throw new UserError(`workspace '${name}' contains an obsolete protected-root path; export needed data and recreate the workspace`);
  }
  if (Object.hasOwn(value, "repositorySnapshot") || Object.hasOwn(value, "repositoryRefOverrides")) {
    throw new UserError(`workspace '${name}' contains an obsolete repository catalog; export needed data and recreate the workspace`);
  }
  if (Object.hasOwn(value, "projectPath") || value.workspaceDataPath !== WORKSPACE_DATA_PATH) {
    throw new UserError(`workspace '${name}' has an invalid workspace data path; export needed data and recreate the workspace`);
  }
  if (value.environment === "minimal") {
    throw new UserError(`workspace '${name}' contains obsolete minimal environment state; use the prior pinned release to export needed data, discard the workspace, and recreate it`);
  }
  if (value.environment !== undefined
    && value.environment !== "recommended" && value.environment !== "custom") {
    throw new UserError(`workspace '${name}' has an invalid environment selection`);
  }
  if (Object.hasOwn(value, "gitBaseUrl")) {
    throw new UserError(`workspace '${name}' mixes native and provider Git state`);
  }
  assertNativeSource(value.source, name);
}

export function validateWorkspaceId(value: unknown, source: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new UserError(`${source} has an invalid workspace instance ID`);
  }
}

export function assertWorkspaceLifecycleActive(record: WorkspaceRecord): void {
  if (record.phase === "discarding") {
    throw new UserError(`workspace '${record.name}' discard is incomplete; retry workspace discard`);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNativeSource(value: unknown, name: string): void {
  if (!isRecord(value) || Object.keys(value).length !== 6 || value.kind !== "native"
    || value.serviceId !== "native-main" || !isRecord(value.snapshot)
    || Object.keys(value.snapshot).length !== 5 || value.snapshot.repositoryId !== "root"
    || typeof value.snapshot.projectId !== "string" || typeof value.snapshot.protectedRef !== "string"
    || typeof value.snapshot.commit !== "string" || typeof value.snapshot.tree !== "string"
    || typeof value.policyRevision !== "string" || typeof value.requiredReviewRevision !== "string"
    || typeof value.requiredJobSetRevision !== "string") {
    throw new UserError(`workspace '${name}' has invalid native source state`);
  }
}
