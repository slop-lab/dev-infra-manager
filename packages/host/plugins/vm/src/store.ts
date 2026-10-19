import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MissingRecordError, UserError, WorkspaceStore, validateResources, type WorkspaceResources } from "@slop-lab/dim-core/workspace";
import { fingerprint, object, text, uuid } from "./config.js";
import { type VmIdentity, IncusMachines } from "./incus.js";

export interface VmGrant { workspaceId: string; workspaceName: string; digest: string }
export interface PersistentVm extends VmIdentity {
  schemaVersion: 1; name: string; createdAt: string; grants: VmGrant[];
}
/** Auxiliary VMs have no fake Git source or core workspace record. Access binds actual core UUIDs. */
export class PersistentVmService {
  readonly directory: string;
  constructor(readonly stateRoot: string, readonly machines: IncusMachines, private readonly workspaces: WorkspaceStore) {
    this.directory = path.join(stateRoot, "plugins", "vm", "instances");
  }
  async list(): Promise<PersistentVm[]> {
    let entries: string[];
    try { entries = await readdir(this.directory); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    return Promise.all(entries.filter((entry) => entry.endsWith(".json")).map((entry) => this.read(entry.slice(0, -5))));
  }
  async read(name: string): Promise<PersistentVm> {
    try {
      const value = parsePersistentVm(JSON.parse(await readFile(this.file(name), "utf8")));
      if (value.name !== name) throw new UserError("persistent VM filename does not match record");
      return value;
    } catch (error) { if (isMissing(error)) throw new MissingRecordError(`persistent VM '${name}' does not exist`); throw error; }
  }
  async create(name: string, image: string, resources: WorkspaceResources): Promise<PersistentVm> {
    validName(name); fingerprint(image); validateResources(resources);
    return this.lock(name, async () => {
      try { await this.read(name); throw new UserError(`persistent VM '${name}' already exists`); }
      catch (error) { if (!(error instanceof MissingRecordError)) throw error; }
      const record: PersistentVm = { schemaVersion: 1, id: randomUUID(), name, image, resources,
        initialized: false, createdAt: new Date().toISOString(), grants: [] };
      await this.write(record);
      await this.machines.create(record);
      // Disk admission succeeded. A later start failure retains the record and disk for recovery.
      record.initialized = true;
      await this.write(record);
      return record;
    });
  }
  async start(name: string): Promise<void> { await this.lock(name, async () => this.machines.start(await this.read(name))); }
  async stop(name: string): Promise<void> { await this.lock(name, async () => this.machines.stop(await this.read(name))); }
  async allocation(name: string, changes: { cpuCount?: number; memory?: string }): Promise<{ cpuCount: number; memory: string }> {
    return this.lock(name, async () => this.machines.updateAllocation(await this.read(name), changes));
  }
  async resources(name: string, changes: Partial<WorkspaceResources>): Promise<PersistentVm> {
    return this.lock(name, async () => {
      const record = await this.read(name);
      const resources = validateResources({ ...record.resources, ...changes });
      await this.machines.updateResources(record, resources);
      const next = { ...record, resources };
      await this.write(next);
      return next;
    });
  }
  async discard(name: string): Promise<void> {
    await this.lock(name, async () => {
      const record = await this.read(name);
      await this.machines.remove(record, { keepData: false });
      await rm(this.file(name));
    });
  }
  async grant(name: string, workspaceName: string): Promise<string> {
    return this.lock(name, async () => {
      const record = await this.read(name);
      const workspace = await this.workspaces.read(workspaceName);
      if (!workspace.initialized || workspace.phase !== "running") throw new UserError("grant access only to an initialized running workspace");
      const token = randomBytes(32).toString("base64url");
      record.grants = record.grants.filter((grant) => grant.workspaceId !== workspace.id);
      record.grants.push({ workspaceId: workspace.id, workspaceName: workspace.name, digest: digest(token) });
      await this.write(record);
      return token;
    });
  }
  async revoke(name: string, workspaceId: string): Promise<void> {
    await this.lock(name, async () => {
      const record = await this.read(name);
      record.grants = record.grants.filter((grant) => grant.workspaceId !== workspaceId);
      await this.write(record);
    });
  }
  async authorize(name: string, token: string): Promise<PersistentVm | undefined> {
    const record = await this.read(name);
    const hash = digest(token);
    for (const grant of record.grants) {
      if (!equal(hash, grant.digest)) continue;
      try {
        const workspace = await this.workspaces.read(grant.workspaceName);
        if (workspace.id === grant.workspaceId && workspace.initialized && workspace.phase === "running") return record;
      } catch (error) { if (!(error instanceof MissingRecordError)) throw error; }
    }
    return undefined;
  }
  private file(name: string): string { return path.join(this.directory, `${validName(name)}.json`); }
  private async write(record: PersistentVm): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file(record.name)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(parsePersistentVm(record), null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.file(record.name));
    } finally { await rm(temporary, { force: true }); }
  }
  private lock<T>(name: string, action: () => Promise<T>): Promise<T> { return this.workspaces.withLock(`vm-${validName(name)}`, action); }
}
export function parsePersistentVm(value: unknown): PersistentVm {
  const record = object(value);
  if (Object.keys(record).sort().join() !== "createdAt,grants,id,image,initialized,name,resources,schemaVersion"
    || record.schemaVersion !== 1 || typeof record.initialized !== "boolean" || !Array.isArray(record.grants)) throw new UserError("invalid persistent VM record");
  const resources = object(record.resources);
  if (Object.keys(resources).sort().join() !== "cpuCount,memory,pidsLimit") throw new UserError("invalid VM resource record");
  const createdAt = text(record.createdAt);
  if (!Number.isFinite(Date.parse(createdAt))) throw new UserError("invalid VM creation time");
  return { schemaVersion: 1, id: uuid(text(record.id)), name: validName(text(record.name)), image: fingerprint(text(record.image)),
    resources: validateResources({ cpuCount: text(resources.cpuCount), memory: text(resources.memory), pidsLimit: text(resources.pidsLimit) }),
    initialized: record.initialized, createdAt, grants: record.grants.map((input: unknown) => {
      const grant = object(input);
      if (Object.keys(grant).sort().join() !== "digest,workspaceId,workspaceName" || !/^[a-f0-9]{64}$/.test(text(grant.digest))) throw new UserError("invalid VM workspace grant");
      return { workspaceId: uuid(text(grant.workspaceId)), workspaceName: validName(text(grant.workspaceName)), digest: text(grant.digest) };
    }) };
}
export function digest(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export function equal(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function validName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(name)) throw new UserError("invalid persistent VM or workspace name");
  return name;
}
function isMissing(error: unknown): boolean { return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
