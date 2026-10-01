import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "./errors.js";
import type { CommandRunner } from "./types.js";

export async function buildSharedGitSyncImage(runner: CommandRunner, image: string): Promise<void> {
  if (!/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*:[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(image)
    || image.endsWith(":latest")) {
    throw new UserError("shared Git sync image destination must be an explicit non-latest tag");
  }
  const root = await mkdtemp(join(tmpdir(), "dim-shared-git-sync-"));
  const context = join(root, "context");
  try {
    await cp(fileURLToPath(new URL("./shared-git-sync-assets", import.meta.url)), context, { recursive: true });
    const result = await runner.run("docker", ["buildx", "build", "--load", "--tag", image, "."], { cwd: context });
    if (result.exitCode !== 0) {
      throw new UserError(`failed to build shared Git sync image '${image}': ${(result.stderr || result.stdout).trim()}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
