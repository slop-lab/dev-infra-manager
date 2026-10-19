import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { MissingRecordError, UserError } from "../errors.js";
import { atomicWrite, validateLifecycleName } from "../lifecycleRecord.js";
import { acquireLifecycleLock } from "../lifecycleLock.js";
import type { AcquiredWorkspaceSource, WorkspaceRecord, WorkspaceResources } from "./models.js";

export function workspaceName(value: string): string {
  return validateLifecycleName(value, "workspace");
}

export function validateResources(value: WorkspaceResources): WorkspaceResources {
  if (!(value.cpuCount === "unlimited" || /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/.test(value.cpuCount))
    || !(value.memory === "unlimited" || /^[1-9][0-9]*(?:[bkmg]|[kmgt]i?b)?$/i.test(value.memory))
    || !(value.pidsLimit === "unlimited" || /^[1-9][0-9]*$/.test(value.pidsLimit))) {
    throw new UserError("invalid workspace resources: use positive CPU, memory and PID limits, or unlimited");
  }
  return { ...value };
}

/** The storage boundary returns fully parsed current records, never type assertions. */
export function parseWorkspaceRecord(value: unknown): WorkspaceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  const fields = ["schemaVersion", "id", "name", "source", "runtime", "image", "resources", "git", "initialized", "phase", "createdAt", "updatedAt"];
  if (Object.keys(record).some((key) => !fields.includes(key) && key !== "error")
    || fields.some((key) => !(key in record)) || record.schemaVersion !== 10) throw invalid();
  const source = object(record.source), resources = object(record.resources), git = object(record.git);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(text(record.id))
    || !/^[a-z][a-z0-9-]{0,31}$/.test(text(record.runtime)) || typeof record.initialized !== "boolean"
    || !["creating", "running", "stopped", "error", "discarding"].includes(text(record.phase))
    || Object.keys(resources).sort().join() !== "cpuCount,memory,pidsLimit"
    || Object.keys(git).sort().join() !== "email,name"
    || !Number.isFinite(Date.parse(text(record.createdAt))) || !Number.isFinite(Date.parse(text(record.updatedAt)))) throw invalid();
  return {
    schemaVersion: 10, id: text(record.id), name: workspaceName(text(record.name)),
    source: parseAcquiredSource(source),
    runtime: text(record.runtime), image: text(record.image), initialized: record.initialized,
    resources: validateResources({ cpuCount: text(resources.cpuCount), memory: text(resources.memory), pidsLimit: text(resources.pidsLimit) }),
    git: { name: text(git.name), email: text(git.email) },
    phase: record.phase as WorkspaceRecord["phase"], createdAt: text(record.createdAt), updatedAt: text(record.updatedAt),
    ...(record.error === undefined ? {} : { error: text(record.error) })
  };
}

export class WorkspaceStore {
  constructor(readonly root: string, private readonly options: { signal?: AbortSignal } = {}) {}

  private file(name: string): string { return path.join(this.root, "workspaces", `${workspaceName(name)}.json`); }

  async read(name: string): Promise<WorkspaceRecord> {
    try {
      const record = parseWorkspaceRecord(JSON.parse(await readFile(this.file(name), "utf8")));
      if (record.name !== name) throw invalid();
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissingRecordError(`workspace '${name}' not found`);
      throw error;
    }
  }

  async list(): Promise<WorkspaceRecord[]> {
    const directory = path.join(this.root, "workspaces");
    let entries: string[];
    try { entries = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const records = await Promise.all(entries.filter((entry) => entry.endsWith(".json")).map((entry) => this.read(entry.slice(0, -5))));
    return records.sort((a, b) => a.name.localeCompare(b.name));
  }

  async write(record: WorkspaceRecord): Promise<void> {
    await atomicWrite(this.file(record.name), parseWorkspaceRecord(record));
  }

  async remove(name: string): Promise<void> { await rm(this.file(name)); }

  async withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    workspaceName(name);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const release = await acquireLifecycleLock({ root: this.root, name: `workspace-${name}`, description: `workspace '${name}' operation`, options: this.options });
    try { this.options.signal?.throwIfAborted(); return await action(); } finally { await release(); }
  }
}

function text(value: unknown): string { if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw invalid(); return value; }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(); return value as Record<string, unknown>; }
function invalid(): UserError { return new UserError("unsupported workspace state; expected a current standalone workspace record"); }

/** Layout paths are immediate children: no traversal, overlapping checkout, or hidden host path. */
export function parseAcquiredSource(value: unknown): AcquiredWorkspaceSource {
  const source = object(value);
  if (Object.keys(source).some((key) => !["url", "ref", "commit", "checkouts", "workingDirectory"].includes(key))
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(text(source.commit))) throw invalid();
  const identity = { url: text(source.url), ref: text(source.ref), commit: text(source.commit) };
  if (source.checkouts === undefined && source.workingDirectory === undefined) return identity;
  if (!Array.isArray(source.checkouts) || source.checkouts.length === 0 || source.checkouts.length > 64) throw invalid();
  const directories = new Set<string>();
  const checkouts = source.checkouts.map((entry: unknown) => {
    const checkout = object(entry);
    const directory = text(checkout.directory);
    if (Object.keys(checkout).sort().join() !== "directory,source"
      || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(directory) || directories.has(directory)) throw invalid();
    directories.add(directory);
    const nested = object(checkout.source);
    if (Object.keys(nested).sort().join() !== "commit,ref,url") throw invalid();
    return { directory, source: parseAcquiredSource(nested) };
  });
  const workingDirectory = text(source.workingDirectory);
  if (!directories.has(workingDirectory)) throw invalid();
  return { ...identity, checkouts, workingDirectory };
}
