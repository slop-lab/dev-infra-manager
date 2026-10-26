import { createHash } from "node:crypto";
import type { WorkspaceRecord } from "./models.js";

export function workspaceRuntimeResources(record: Pick<WorkspaceRecord, "id">) {
  const prefix = `dim-workspace-${createHash("sha256").update(record.id).digest("hex").slice(0, 24)}`;
  return {
    container: prefix,
    network: prefix,
    home: `${prefix}-home`,
    checkout: `${prefix}-checkout`,
    docker: `${prefix}-docker`,
    tmp: `${prefix}-tmp`
  };
}
