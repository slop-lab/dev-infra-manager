import { UserError } from "./errors.js";
import { assertSchemaVersion, assertSysboxWorkspace } from "./lifecycleRecord.js";
import type { WorkspaceRecord } from "./lifecycleTypes.js";

const WORKSPACE_DATA_PATH = "/var/lib/dim/workspace-data";

export function assertWorkspaceRecord(value: unknown, source: string): asserts value is WorkspaceRecord {
  if (!isRecord(value)) throw new UserError(`workspace state at '${source}' must be an object`);
  const name = typeof value.name === "string" ? value.name : source;
  if (value.schemaVersion !== 8 && value.schemaVersion !== 9) assertSchemaVersion(value, "workspace", name, 8);
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
  if (value.schemaVersion === 9) {
    if (Object.hasOwn(value, "gitBaseUrl")) {
      throw new UserError(`workspace '${name}' mixes native and provider Git state`);
    }
    assertNativeSource(value.source, name);
    return;
  }
  if (Object.hasOwn(value, "source") || typeof value.gitBaseUrl !== "string") {
    throw new UserError(`workspace '${name}' has invalid Gitea source state`);
  }
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
