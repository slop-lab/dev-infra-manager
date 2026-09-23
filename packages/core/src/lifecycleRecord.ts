import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { MissingRecordError, UserError } from "./errors.js";

export function validateLifecycleName(value: string, kind: string): string {
  if (!/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(value)) {
    throw new UserError(`${kind} name must match [a-z0-9][a-z0-9_.-]{0,47}`);
  }
  return value;
}

export async function atomicWrite(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

export async function readJson<T>(target: string, missingMessage: string): Promise<T> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new MissingRecordError(missingMessage);
    }
    throw error;
  }
}

export async function listRecords<T extends { schemaVersion: number; name: string }>(
  directory: string,
  kind: string,
  expectedSchemaVersion: number
): Promise<T[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(entries.filter((entry) => entry.endsWith(".json")).map(async (entry) => {
    const record = await readJson<T>(path.join(directory, entry), `invalid ${kind} record: ${entry}`);
    assertSchemaVersion(record, kind, record.name, expectedSchemaVersion);
    return record;
  }));
  return records.sort((left, right) => left.name.localeCompare(right.name));
}

export function assertSchemaVersion(
  record: { schemaVersion?: number },
  kind: string,
  name: string,
  expected = 3
): void {
  if (record.schemaVersion !== expected) {
    throw new UserError(
      `${kind} '${name}' uses unsupported state schema ${String(record.schemaVersion)}; `
      + `expected ${expected}. Export needed data and recreate this ${kind}; DIM will not migrate or delete it`
    );
  }
}

export function assertSysboxWorkspace(record: { runtimeBackend?: unknown }, name: string): void {
  if (record.runtimeBackend !== "sysbox") {
    throw new UserError(
      `workspace '${name}' uses unsupported backend '${String(record.runtimeBackend)}'; `
      + "DIM supports only sysbox workspaces"
    );
  }
}
