import { UserError } from "./errors.js";
import { validateLifecycleName } from "./lifecycleRecord.js";
import type { HostLifecycleRecord } from "./lifecycleTypes.js";

const REQUIRED_FIELDS = [
  "schemaVersion",
  "phase",
  "resumeWorkspaces",
  "restartCiRunners",
  "resumeManagedContainers",
  "updatedAt"
] as const;

const OPTIONAL_FIELDS = ["error"] as const;
const RUNNER_TARGET_FIELDS = ["project", "name"] as const;
const NO_OPTIONAL_FIELDS: readonly string[] = [];

export function parseHostLifecycleRecord(value: unknown): HostLifecycleRecord {
  const record = object(value, "host lifecycle state");
  exactFields(record, REQUIRED_FIELDS, OPTIONAL_FIELDS);
  if (record.schemaVersion !== 2) {
    throw new UserError(
      `host lifecycle 'host' uses unsupported state schema ${String(record.schemaVersion)}; `
      + "expected 2 and DIM does not migrate existing state"
    );
  }

  const parsed = {
    schemaVersion: 2,
    phase: hostPhase(record.phase),
    resumeWorkspaces: lifecycleNames(record.resumeWorkspaces, "workspace", "resumeWorkspaces"),
    restartCiRunners: runnerTargets(record.restartCiRunners),
    resumeManagedContainers: lifecycleNames(
      record.resumeManagedContainers,
      "managed container",
      "resumeManagedContainers"
    ),
    updatedAt: text(record.updatedAt, "updatedAt")
  } satisfies HostLifecycleRecord;

  if (record.error === undefined) return parsed;
  return { ...parsed, error: text(record.error, "error") };
}

function hostPhase(value: unknown): HostLifecycleRecord["phase"] {
  switch (value) {
    case "ready":
    case "stopping":
    case "stopped":
    case "starting":
    case "error":
      return value;
    default:
      throw invalid("phase");
  }
}

function lifecycleNames(value: unknown, kind: string, field: string): string[] {
  if (!Array.isArray(value)) throw invalid(field);
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw invalid(`${field}[${index}]`);
    return validateLifecycleName(entry, kind);
  });
}

function runnerTargets(value: unknown): HostLifecycleRecord["restartCiRunners"] {
  if (!Array.isArray(value)) throw invalid("restartCiRunners");
  return value.map((entry, index) => {
    const label = `restartCiRunners[${index}]`;
    const target = object(entry, label);
    exactFields(target, RUNNER_TARGET_FIELDS, NO_OPTIONAL_FIELDS);
    if (typeof target.project !== "string") throw invalid(`${label}.project`);
    if (typeof target.name !== "string") throw invalid(`${label}.name`);
    return {
      project: validateLifecycleName(target.project, "project"),
      name: validateLifecycleName(target.name, "CI runner")
    };
  });
}

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw invalid(label);
  return value;
}

function exactFields(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[]
): void {
  const unknown = Object.keys(value).find((field) => !required.includes(field) && !optional.includes(field));
  if (unknown !== undefined) throw new UserError(`host lifecycle state contains unknown field '${unknown}'`);
  const missing = required.find((field) => value[field] === undefined);
  if (missing !== undefined) throw new UserError(`host lifecycle state.${missing} is required`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid(field);
  return value;
}

function invalid(field: string): UserError {
  return new UserError(`host lifecycle state has invalid ${field}`);
}
