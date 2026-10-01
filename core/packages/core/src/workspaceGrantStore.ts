import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceRecord } from "./lifecycleTypes.js";
import { validateLifecycleName } from "./lifecycleRecord.js";
import { validateWorkspaceId } from "./workspaceRecord.js";

type GrantAudience = "workspace" | "agent";

export class WorkspaceGrantStore {
  constructor(private readonly root: string) {}

  async ensure(record: WorkspaceRecord, audience: GrantAudience): Promise<string> {
    const target = this.pathFor(record.name, record.workspaceId, audience);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      return (await readFile(target, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const encodedName = Buffer.from(record.name).toString("base64url");
    const token = `${encodedName}.${record.workspaceId}.${randomBytes(32).toString("base64url")}`;
    try {
      const handle = await open(target, "wx", 0o600);
      await handle.writeFile(`${token}\n`, "utf8");
      await handle.close();
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return (await readFile(target, "utf8")).trim();
      throw error;
    }
  }

  async read(record: Pick<WorkspaceRecord, "name" | "workspaceId">, audience: GrantAudience): Promise<string> {
    return (await readFile(this.pathFor(record.name, record.workspaceId, audience), "utf8")).trim();
  }

  async authenticate(
    token: string,
    audience: GrantAudience,
    readWorkspace: (name: string) => Promise<WorkspaceRecord>
  ): Promise<WorkspaceRecord | undefined> {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const [encodedName, workspaceId] = parts;
    if (encodedName === undefined || workspaceId === undefined) return undefined;
    try {
      const name = validateLifecycleName(Buffer.from(encodedName, "base64url").toString("utf8"), "workspace");
      validateWorkspaceId(workspaceId, `workspace '${name}'`);
      const expected = (await readFile(this.pathFor(name, workspaceId, audience), "utf8")).trim();
      const actualBuffer = Buffer.from(token);
      const expectedBuffer = Buffer.from(expected);
      if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return undefined;
      const record = await readWorkspace(name);
      return record.workspaceId === workspaceId && record.phase !== "discarding" ? record : undefined;
    } catch {
      return undefined;
    }
  }

  async remove(record: Pick<WorkspaceRecord, "name" | "workspaceId">, audience: GrantAudience): Promise<void> {
    await rm(this.pathFor(record.name, record.workspaceId, audience), { force: true });
  }

  private pathFor(name: string, workspaceId: string, audience: GrantAudience): string {
    validateLifecycleName(name, "workspace");
    validateWorkspaceId(workspaceId, `workspace '${name}'`);
    return path.join(this.root, `${audience}-grants`, `${name}.${workspaceId}`);
  }
}
