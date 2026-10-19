import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { validateLifecycleName } from "@slop-lab/dim-host-core";
import { MissingRecordError, UserError, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";

type Identity = Pick<WorkspaceRecord, "name" | "id">;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Optional plugin grants are host-owned and bound to the core workspace UUID. */
export class WorkspaceGrantStore {
  constructor(private readonly root: string) {}

  async ensure(record: Identity): Promise<string> {
    const target = this.pathFor(record);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try { return await this.read(record); }
    catch (error) { if (!missing(error)) throw error; }
    const token = `${Buffer.from(record.name).toString("base64url")}.${record.id}.${randomBytes(32).toString("base64url")}`;
    let handle;
    try { handle = await open(target, "wx", 0o600); }
    catch (error) { if (isCode(error, "EEXIST")) return this.read(record); throw error; }
    try { await handle.writeFile(`${token}\n`, "utf8"); }
    finally { await handle.close(); }
    return token;
  }

  async read(record: Identity): Promise<string> {
    const token = (await readFile(this.pathFor(record), "utf8")).trim();
    if (!this.identity(token) || !token.startsWith(`${Buffer.from(record.name).toString("base64url")}.${record.id}.`)) {
      throw new UserError("workspace plugin grant is invalid");
    }
    return token;
  }

  async authenticate(token: string, readWorkspace: (name: string) => Promise<WorkspaceRecord>): Promise<WorkspaceRecord | undefined> {
    const identity = this.identity(token);
    if (!identity) return undefined;
    try {
      const expected = Buffer.from(await this.read(identity)), actual = Buffer.from(token);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
      const record = await readWorkspace(identity.name);
      return record.id === identity.id && record.phase !== "discarding" && record.initialized ? record : undefined;
    } catch (error) { if (missing(error) || error instanceof MissingRecordError) return undefined; throw error; }
  }

  async remove(record: Identity): Promise<void> { await rm(this.pathFor(record), { force: true }); }

  private identity(token: string): Identity | undefined {
    const [encodedName, id, secret, ...extra] = token.split(".");
    if (!encodedName || !id || !secret || extra.length || !uuid.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return undefined;
    const name = Buffer.from(encodedName, "base64url").toString("utf8");
    if (Buffer.from(name).toString("base64url") !== encodedName) return undefined;
    try { return { name: validateLifecycleName(name, "workspace"), id }; } catch { return undefined; }
  }

  private pathFor(record: Identity): string {
    validateLifecycleName(record.name, "workspace");
    if (!uuid.test(record.id)) throw new UserError("invalid workspace plugin grant identity");
    return path.join(this.root, "workspace-grants", `${record.name}.${record.id}`);
  }
}
function isCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
function missing(error: unknown): boolean { return isCode(error, "ENOENT"); }
