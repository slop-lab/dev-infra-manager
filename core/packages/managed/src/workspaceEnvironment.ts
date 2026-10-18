import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "@slop-lab/dim-core";

export type WorkspaceEnvironment = "recommended" | "custom";

const customFiles = ["setup.sh", "entrypoint.sh", "teardown.sh", "docker-compose.yml"] as const;

export async function selectWorkspaceEnvironment(snapshotRoot: string): Promise<WorkspaceEnvironment> {
  const directory = join(snapshotRoot, ".dim");
  const directoryMetadata = await metadata(directory);
  if (directoryMetadata === undefined) return "recommended";
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new UserError("workspace .dim path must be a directory and not a symbolic link");
  }
  if (await metadata(join(directory, "environment.yml")) !== undefined) {
    throw new UserError(".dim/environment.yml is unsupported; customize the Project lifecycle or Compose files instead");
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
  return custom ? "custom" : "recommended";
}

async function metadata(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
