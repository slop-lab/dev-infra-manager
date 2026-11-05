import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MissingRecordError, UserError, WorkspaceStore, validateResources, type WorkspaceRecord, type WorkspaceResources } from "@slop-lab/dim-host-core/workspace";
import { fingerprint, object, text, uuid } from "./config.js";
import { type VmIdentity, IncusMachines } from "./incus.js";

export const vmPermissions = ["console", "copy", "discover", "exec", "lifecycle", "status"] as const;
export type VmPermission = typeof vmPermissions[number];
export interface VmGrant {
  workspaceId: string; workspaceName: string; digest: string; grantId: string; generation: number;
  permissions: VmPermission[]; createdAt: string;
}
export interface VmGrantCredential {
  readonly grantId: string; readonly generation: number; readonly vmId: string; readonly vmName: string;
  readonly workspaceId: string; readonly workspaceName: string; readonly permissions: readonly VmPermission[]; readonly token: string;
}
export interface VmAuthorization { readonly vm: PersistentVm; readonly grant: VmGrant; readonly workspace: WorkspaceRecord }
export interface VmGrantIdentity { readonly workspaceId: string; readonly grantId: string; readonly generation: number }
export interface VmLifecycleAccess extends VmGrantIdentity {
  readonly token: string; readonly vmId: string; readonly vmName: string; readonly operation: "start" | "stop";
}
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
  async start(name: string, expectedId?: string): Promise<void> { await this.lock(name, async () => {
    const record = await this.read(name); requireVmIdentity(record, expectedId); await this.startReady(record);
  }); }
  async stop(name: string, expectedId?: string): Promise<void> { await this.lock(name, async () => {
    const record = await this.read(name); requireVmIdentity(record, expectedId); await this.machines.stop(record);
  }); }
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
    return (await this.grantAccess(name, workspaceName, ["console"])).token;
  }
  async grantAccess(name: string, workspaceName: string, requested: readonly VmPermission[]): Promise<VmGrantCredential> {
    return this.lock(name, async () => {
      const record = await this.read(name);
      const workspace = await this.workspaces.read(workspaceName);
      if (!workspace.initialized || workspace.phase !== "running") throw new UserError("grant access only to an initialized running workspace");
      const permissions = parsePermissions(requested);
      const token = randomBytes(32).toString("base64url");
      const previous = record.grants.find((grant) => grant.workspaceId === workspace.id);
      const grant: VmGrant = { workspaceId: workspace.id, workspaceName: workspace.name, digest: digest(token),
        grantId: randomUUID(), generation: (previous?.generation ?? 0) + 1, permissions, createdAt: new Date().toISOString() };
      record.grants = record.grants.filter((grant) => grant.workspaceId !== workspace.id);
      record.grants.push(grant);
      await this.write(record);
      return { grantId: grant.grantId, generation: grant.generation, vmId: record.id, vmName: record.name,
        workspaceId: workspace.id, workspaceName: workspace.name, permissions: grant.permissions, token };
    });
  }
  async revoke(name: string, workspaceId: string): Promise<void> {
    await this.lock(name, async () => {
      const record = await this.read(name);
      record.grants = record.grants.filter((grant) => grant.workspaceId !== workspaceId);
      await this.write(record);
    });
  }
  async revokeGrant(name: string, identity: VmGrantIdentity): Promise<void> {
    await this.lock(name, async () => {
      const record = await this.read(name);
      record.grants = record.grants.filter((grant) => grant.workspaceId !== identity.workspaceId
        || grant.grantId !== identity.grantId || grant.generation !== identity.generation);
      await this.write(record);
    });
  }
  async lifecycleAccess(input: VmLifecycleAccess): Promise<void> {
    await this.lock(input.vmName, async () => {
      const access = await this.authorizeAccess(input.vmName, input.token, { permission: "lifecycle", vmId: input.vmId,
        workspaceId: input.workspaceId, grantId: input.grantId, generation: input.generation });
      if (!access) throw new UserError("VM access denied or expired");
      if (input.operation === "start") await this.startReady(access.vm); else await this.machines.stop(access.vm);
    });
  }
  async authorize(name: string, token: string): Promise<PersistentVm | undefined> {
    return (await this.authorizeAccess(name, token, { permission: "console" }))?.vm;
  }
  async authorizeAccess(name: string, token: string, request: {
    readonly permission: VmPermission; readonly vmId?: string; readonly workspaceId?: string;
    readonly grantId?: string; readonly generation?: number;
  }): Promise<VmAuthorization | undefined> {
    const record = await this.read(name);
    if (request.vmId !== undefined && record.id !== request.vmId) return;
    const hash = digest(token);
    for (const grant of record.grants) {
      if (!equal(hash, grant.digest) || !grant.permissions.includes(request.permission)
        || request.workspaceId !== undefined && grant.workspaceId !== request.workspaceId
        || request.grantId !== undefined && grant.grantId !== request.grantId
        || request.generation !== undefined && grant.generation !== request.generation) continue;
      try {
        const workspace = await this.workspaces.read(grant.workspaceName);
        if (workspace.id === grant.workspaceId && workspace.initialized && workspace.phase === "running") {
          return { vm: record, grant, workspace };
        }
      } catch (error) { if (!(error instanceof MissingRecordError)) throw error; }
    }
    return undefined;
  }
  private file(name: string): string { return path.join(this.directory, `${validName(name)}.json`); }
  private async startReady(record: PersistentVm): Promise<void> {
    const before = await this.machines.inspect(record), started = before?.running !== true;
    await this.machines.start(record);
    try {
      await this.machines.waitForAgent(record);
      const ready = await this.machines.exec(record, ["sh", "-eu", "-c",
        'test -d /workspace && test ! -L /workspace && test -w /workspace && test -d /mnt/dim-tmp && test ! -L /mnt/dim-tmp && test -w /mnt/dim-tmp && test "$(stat -c %a /mnt/dim-tmp)" = 700']);
      if (ready !== 0) throw new UserError("auxiliary VM image must provide writable /workspace and private mode-0700 /mnt/dim-tmp for user dim");
    } catch (error) {
      if (!started) throw error;
      try { await this.machines.stop(record); }
      catch (stopError) { throw new AggregateError([error, stopError], "auxiliary VM readiness failed and the started VM could not be stopped"); }
      throw error;
    }
  }
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
      const keys = Object.keys(grant).sort().join();
      if (!/^[a-f0-9]{64}$/.test(text(grant.digest))) throw new UserError("invalid VM workspace grant");
      const workspaceId = uuid(text(grant.workspaceId)), workspaceName = validName(text(grant.workspaceName));
      if (keys === "digest,workspaceId,workspaceName") {
        return { workspaceId, workspaceName, digest: text(grant.digest), grantId: workspaceId, generation: 1,
          permissions: ["console"] as VmPermission[], createdAt };
      }
      if (keys !== "createdAt,digest,generation,grantId,permissions,workspaceId,workspaceName"
        || !Number.isSafeInteger(grant.generation) || Number(grant.generation) < 1 || !Array.isArray(grant.permissions)) {
        throw new UserError("invalid VM workspace grant");
      }
      const grantCreatedAt = text(grant.createdAt);
      if (!Number.isFinite(Date.parse(grantCreatedAt))) throw new UserError("invalid VM grant creation time");
      return { workspaceId, workspaceName, digest: text(grant.digest), grantId: uuid(text(grant.grantId)),
        generation: Number(grant.generation), permissions: parsePermissions(grant.permissions), createdAt: grantCreatedAt };
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
function requireVmIdentity(record: PersistentVm, expectedId?: string): void {
  if (expectedId !== undefined && record.id !== expectedId) throw new UserError("persistent VM identity changed");
}
function parsePermissions(input: readonly unknown[]): VmPermission[] {
  const permissions = input.map((permission) => {
    switch (permission) {
      case "console": case "copy": case "discover": case "exec": case "lifecycle": case "status": return permission;
      default: throw new UserError("invalid VM grant permission");
    }
  }).sort();
  if (!permissions.length || new Set(permissions).size !== permissions.length) throw new UserError("VM grant permissions must be nonempty and unique");
  return permissions;
}
function isMissing(error: unknown): boolean { return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
