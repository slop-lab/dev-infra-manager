import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Pin integration fixtures to the binary they actually execute, once per test worker. */
export const realGitExecutable = "/usr/bin/git";
const output = execFileSync(realGitExecutable, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const match = /^git version ([0-9]+\.[0-9]+\.[0-9]+(?:[A-Za-z0-9._-]*)?)$/.exec(output);
if (match === null) throw new Error(`Unexpected Git version output from ${realGitExecutable}`);
export const realGitVersion = match[1]!;

export async function createTraversalRejectingGit(root: string): Promise<{
  readonly gitExecutable: string;
  readonly gitVersion: string;
  readonly forbiddenInvocation: string;
}> {
  const gitExecutable = join(root, "git");
  const forbiddenInvocation = join(root, "forbidden-git-traversal");
  await writeFile(gitExecutable, `#!/bin/sh
set -eu
for argument in "$@"; do
  case "$argument" in
    fsck|--batch-all-objects)
      : > ${JSON.stringify(forbiddenInvocation)}
      exit 97
      ;;
  esac
done
exec ${realGitExecutable} "$@"
`, { mode: 0o700 });
  return { gitExecutable, gitVersion: realGitVersion, forbiddenInvocation };
}
