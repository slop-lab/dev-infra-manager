import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "./errors.js";
import type { CommandRunner, LongOperationOptions } from "./types.js";
import { workspaceImageReference } from "./workspaceImageReference.js";

export type WorkspaceImageBuild = { readonly image: string };

/** Build the base runtime only; managed service/relay assets belong to their integration. */
export async function buildWorkspaceImage(
  runner: CommandRunner,
  env: NodeJS.ProcessEnv = process.env,
  operation: LongOperationOptions = {}
): Promise<WorkspaceImageBuild> {
  const image = workspaceImageReference(env.DIM_WORKSPACE_IMAGE);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:+-]*$/.test(image) || image.includes("@")) {
    throw new UserError("build destination must be an image repository/tag, not a digest");
  }
  if (process.getuid === undefined || process.getgid === undefined) throw new UserError("workspace image builds require a Linux host");
  const temporary = await mkdtemp(join(tmpdir(), "dim-workspace-image-"));
  const context = join(temporary, "context");
  try {
    await cp(fileURLToPath(new URL("./workspace-image-assets", import.meta.url)), context, { recursive: true });
    operation.reportProgress?.("Building the base workspace image");
    const result = await runner.run("docker", [
      "buildx", "build", "--load", "--build-arg", `DIM_UID=${process.getuid()}`,
      "--build-arg", `DIM_GID=${process.getgid()}`, "--tag", image, "--file", "Dockerfile", "."
    ], { cwd: context, ...(operation.signal === undefined ? {} : { signal: operation.signal }) });
    if (result.exitCode !== 0) throw new UserError(`failed to build workspace image '${image}': ${(result.stderr || result.stdout).trim()}`);
    return { image };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
