import { UserError } from "@slop-lab/dim-core";
import type { ProjectRecord } from "./lifecycleTypes.js";
import { parseNativeProjectPendingRecord } from "./nativeProjectPendingCodec.js";

export function parseProjectRecord(value: unknown): ProjectRecord {
  if (isPredecessorProject(value)) {
    throw new UserError(
      "Project uses unsupported predecessor state; use the prior pinned release to export needed data, then recreate the Project"
    );
  }
  const record = parseNativeProjectPendingRecord(value);
  if (record.schemaVersion !== 6 || record.phase !== "ready") {
    throw new UserError("Project is not ready");
  }
  return record;
}

function isPredecessorProject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Reflect.get(value, "schemaVersion") === 4;
}
