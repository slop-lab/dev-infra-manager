import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { UserError } from "./errors.js";
import { convertHostLifecycleSchema1, parseHostLifecycleRecord } from "./hostLifecycleRecord.js";
import type { LifecycleState } from "./lifecycleState.js";
import type { HostLifecycleRecord } from "./lifecycleTypes.js";

export type HostStateMigrationResult = {
  readonly kind: "unchanged" | "migrated" | "recovered";
};

type Artifact =
  | { readonly kind: "missing" }
  | { readonly kind: "file"; readonly bytes: Buffer };

type ParsedHostState =
  | { readonly schema: 1; readonly converted: HostLifecycleRecord }
  | { readonly schema: 2; readonly record: HostLifecycleRecord };

const TEMPORARY_PATTERN = /^host\.json\.schema-(?:1\.backup|2\.replace)\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function migrateHostLifecycleState(state: LifecycleState): Promise<HostStateMigrationResult> {
  const release = await state.acquireHostLifecycleLock();
  try {
    return await migrateLocked(state.hostLifecyclePath());
  } finally {
    await release();
  }
}

async function migrateLocked(canonicalPath: string): Promise<HostStateMigrationResult> {
  const directory = path.dirname(canonicalPath);
  const backupPath = path.join(directory, "host.json.schema-1.bak");
  const canonical = await inspectArtifact(canonicalPath, "canonical host lifecycle state", false);
  const backup = await inspectArtifact(backupPath, "host lifecycle schema 1 backup", true);
  const temporaries = await inspectTemporaries(directory);
  const parsedBackup = backup.kind === "file" ? parseState(backup.bytes, backupPath) : undefined;
  if (parsedBackup !== undefined && parsedBackup.schema !== 1) {
    throw new UserError("host lifecycle schema 1 backup does not contain schema 1 state");
  }

  if (canonical.kind === "missing") {
    if (parsedBackup === undefined) {
      await removeTemporaries(directory, temporaries);
      return { kind: "unchanged" };
    }
    await removeTemporaries(directory, temporaries);
    await replaceCanonical(canonicalPath, parsedBackup.converted);
    await validateCanonical(canonicalPath);
    return { kind: "recovered" };
  }

  const parsedCanonical = parseState(canonical.bytes, canonicalPath);
  if (parsedCanonical.schema === 2) {
    if (parsedBackup !== undefined && !recordsEqual(parsedCanonical.record, parsedBackup.converted)) {
      throw new UserError("host lifecycle schema 1 backup conflicts with canonical schema 2 state");
    }
    await removeTemporaries(directory, temporaries);
    return { kind: "unchanged" };
  }

  if (backup.kind === "file" && !canonical.bytes.equals(backup.bytes)) {
    throw new UserError("host lifecycle schema 1 backup conflicts with canonical schema 1 bytes");
  }
  await removeTemporaries(directory, temporaries);
  if (backup.kind === "missing") await publishBackup(backupPath, canonical.bytes);
  await replaceCanonical(canonicalPath, parsedCanonical.converted);
  await validateCanonical(canonicalPath);
  return { kind: "migrated" };
}

async function inspectArtifact(target: string, label: string, requirePrivateMode: boolean): Promise<Artifact> {
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "missing" };
    throw error;
  }
  if (!metadata.isFile()) throw new UserError(`${label} must be a regular file, not a symlink or special file`);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new UserError(`${label} must be a regular file`);
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new UserError(`${label} changed while it was inspected`);
    }
    if (requirePrivateMode && (opened.mode & 0o777) !== 0o600) {
      throw new UserError(`${label} must have mode 0600`);
    }
    return { kind: "file", bytes: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

async function inspectTemporaries(directory: string): Promise<readonly string[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const temporaries = entries.filter((entry) => TEMPORARY_PATTERN.test(entry));
  for (const entry of temporaries) {
    const target = path.join(directory, entry);
    const metadata = await lstat(target);
    const label = `host lifecycle temporary '${entry}'`;
    if (!metadata.isFile()) throw new UserError(`${label} must be a regular file`);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
        throw new UserError(`${label} changed while it was inspected`);
      }
      if ((opened.mode & 0o777) !== 0o600) throw new UserError(`${label} must have mode 0600`);
    } finally {
      await handle.close();
    }
  }
  return temporaries;
}

async function publishBackup(backupPath: string, bytes: Buffer): Promise<void> {
  const directory = path.dirname(backupPath);
  const temporary = path.join(directory, `host.json.schema-1.backup.tmp-${process.pid}-${randomUUID()}`);
  await writeSyncedExclusive(temporary, bytes);
  try {
    await link(temporary, backupPath);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
    await syncDirectory(directory);
  }
}

async function replaceCanonical(canonicalPath: string, record: HostLifecycleRecord): Promise<void> {
  const directory = path.dirname(canonicalPath);
  const temporary = path.join(directory, `host.json.schema-2.replace.tmp-${process.pid}-${randomUUID()}`);
  await writeSyncedExclusive(temporary, Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
  try {
    await rename(temporary, canonicalPath);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
    await syncDirectory(directory);
  }
}

async function writeSyncedExclusive(target: string, bytes: Buffer): Promise<void> {
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeTemporaries(directory: string, entries: readonly string[]): Promise<void> {
  if (entries.length === 0) return;
  for (const entry of entries) await rm(path.join(directory, entry));
  await syncDirectory(directory);
}

async function validateCanonical(canonicalPath: string): Promise<void> {
  const artifact = await inspectArtifact(canonicalPath, "canonical host lifecycle state", false);
  if (artifact.kind === "missing") throw new UserError("canonical host lifecycle state disappeared after replacement");
  parseHostLifecycleRecord(parseJson(artifact.bytes, canonicalPath));
}

function parseState(bytes: Buffer, source: string): ParsedHostState {
  const value = parseJson(bytes, source);
  if (!isRecord(value)) throw new UserError(`host lifecycle state in '${source}' must be an object`);
  if (value.schemaVersion === 1) return { schema: 1, converted: convertHostLifecycleSchema1(value) };
  return { schema: 2, record: parseHostLifecycleRecord(value) };
}

function parseJson(bytes: Buffer, source: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new UserError(`host lifecycle state in '${source}' is not valid JSON`);
    throw error;
  }
}

function recordsEqual(left: HostLifecycleRecord, right: HostLifecycleRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
