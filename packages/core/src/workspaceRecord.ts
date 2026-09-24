import { UserError } from "./errors.js";
import { assertSchemaVersion, assertSysboxWorkspace } from "./lifecycleRecord.js";
import type { WorkspaceRecord } from "./lifecycleTypes.js";
import { WORKSPACE_DATA } from "./workspaceLifecycleTypes.js";

export function assertWorkspaceRecord(value: unknown, source: string): asserts value is WorkspaceRecord {
  if (!isRecord(value)) throw new UserError(`workspace state at '${source}' must be an object`);
  const name = typeof value.name === "string" ? value.name : source;
  assertSchemaVersion(value, "workspace", name, 6);
  assertSysboxWorkspace(value, name);
  if (Object.hasOwn(value, "repositorySnapshot") || Object.hasOwn(value, "repositoryRefOverrides")) {
    throw new UserError(`workspace '${name}' contains an obsolete repository catalog; export needed data and recreate the workspace`);
  }
  if (Object.hasOwn(value, "projectPath") || value.workspaceDataPath !== WORKSPACE_DATA) {
    throw new UserError(`workspace '${name}' has an invalid workspace data path; export needed data and recreate the workspace`);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
