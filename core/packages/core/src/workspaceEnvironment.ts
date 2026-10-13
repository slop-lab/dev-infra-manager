import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { UserError } from "./errors.js";

export type WorkspaceEnvironment = "recommended" | "minimal" | "custom";

const customFiles = ["setup.sh", "entrypoint.sh", "teardown.sh", "docker-compose.yml"] as const;
const MAX_SELECTOR_BYTES = 4_096;

export async function selectWorkspaceEnvironment(snapshotRoot: string): Promise<WorkspaceEnvironment> {
  const directory = join(snapshotRoot, ".dim");
  const directoryMetadata = await metadata(directory);
  if (directoryMetadata === undefined) return "recommended";
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new UserError("workspace .dim path must be a directory and not a symbolic link");
  }
  let custom = false;
  for (const name of customFiles) {
    const fileMetadata = await metadata(join(directory, name));
    if (fileMetadata === undefined) continue;
    if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink()) {
      throw new UserError(`workspace custom lifecycle file '.dim/${name}' must be a regular file and not a symbolic link`);
    }
    custom = true;
  }
  const selectorPath = join(directory, "environment.yml");
  const selectorMetadata = await metadata(selectorPath);
  if (selectorMetadata === undefined) return custom ? "custom" : "recommended";
  if (!selectorMetadata.isFile() || selectorMetadata.isSymbolicLink()) {
    throw new UserError("workspace environment selector must be a regular file and not a symbolic link");
  }
  const handle = await open(selectorPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(MAX_SELECTOR_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_SELECTOR_BYTES) {
      throw new UserError(`workspace environment selector exceeds ${MAX_SELECTOR_BYTES} bytes`);
    }
    const document = parseDocument(buffer.subarray(0, bytesRead).toString("utf8"), { uniqueKeys: true });
    if (document.errors.length > 0) throw invalidEnvironment();
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (!isExactMinimalEnvironment(value)) throw invalidEnvironment();
  } finally {
    await handle.close();
  }
  if (custom) throw new UserError("minimal workspace environment cannot coexist with custom lifecycle files");
  return "minimal";
}

async function metadata(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isExactMinimalEnvironment(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 2
    && Reflect.get(value, "schemaVersion") === 1
    && Reflect.get(value, "environment") === "minimal";
}

function invalidEnvironment(): UserError {
  return new UserError("workspace environment selector must be exactly schemaVersion: 1 and environment: minimal");
}
