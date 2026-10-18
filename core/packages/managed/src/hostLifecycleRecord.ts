import { UserError } from "@slop-lab/dim-core";
import { validateLifecycleName } from "@slop-lab/dim-core";
import type { HostLifecycleRecord } from "./lifecycleTypes.js";

export function parseHostLifecycleRecord(value: unknown): HostLifecycleRecord {
  if (!isRecord(value)) throw new UserError("host lifecycle state must be an object");
  if (value.schemaVersion !== 2) {
    throw new UserError(
      "host lifecycle state uses unsupported predecessor state; use the prior pinned release to complete recovery before upgrading"
    );
  }
  const allowed = new Set(["schemaVersion", "phase", "resumeWorkspaces", "updatedAt", "error"]);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown !== undefined) {
    throw new UserError(
      "host lifecycle state contains predecessor recovery targets; use the prior pinned release to complete recovery before upgrading"
    );
  }
  const phase = hostPhase(value.phase);
  if (!Array.isArray(value.resumeWorkspaces)) throw invalid("resumeWorkspaces");
  const resumeWorkspaces = value.resumeWorkspaces.map((entry, index) => {
    if (typeof entry !== "string") throw invalid(`resumeWorkspaces[${index}]`);
    return validateLifecycleName(entry, "workspace");
  });
  if (typeof value.updatedAt !== "string" || value.updatedAt.length === 0) throw invalid("updatedAt");
  const record: HostLifecycleRecord = {
    schemaVersion: 2,
    phase,
    resumeWorkspaces,
    updatedAt: value.updatedAt
  };
  if (value.error === undefined) return record;
  if (typeof value.error !== "string" || value.error.length === 0) throw invalid("error");
  return { ...record, error: value.error };
}

function hostPhase(value: unknown): HostLifecycleRecord["phase"] {
  if (value === "ready" || value === "stopping" || value === "stopped"
    || value === "starting" || value === "error") return value;
  throw invalid("phase");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(field: string): UserError {
  return new UserError(`host lifecycle state has invalid ${field}`);
}
