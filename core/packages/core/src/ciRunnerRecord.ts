import { UserError } from "./errors.js";
import { assertSchemaVersion } from "./lifecycleRecord.js";
import type { CiRunnerRecord } from "./lifecycleTypes.js";

export function assertCiRunnerRecord(value: unknown, source: string): asserts value is CiRunnerRecord {
  if (!isRecord(value)) throw new UserError(`CI runner state at '${source}' must be an object`);
  const name = typeof value.name === "string" ? value.name : source;
  assertSchemaVersion(value, "CI runner", name, 8);
  if (typeof value.name !== "string" || typeof value.projectName !== "string") {
    throw new UserError(`CI runner state at '${source}' has invalid identity fields`);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
