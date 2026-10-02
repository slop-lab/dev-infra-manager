import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { NativeGitRepository, NativeGitServiceConfig } from "./config.js";
import { NativeGitConfigError } from "./config.js";

const execute = promisify(execFile);
const hook = `#!/bin/sh
set -eu
workspace="\${DIM_NATIVE_GIT_WORKSPACE_ID-}"
case "$workspace" in
  ""|*[!a-z0-9-]*) printf '%s\\n' 'DIM proposal identity is invalid' >&2; exit 1 ;;
esac
zero=0000000000000000000000000000000000000000
allowed="refs/heads/proposals/$workspace/"
while IFS=' ' read -r old new ref; do
  case "$ref" in "$allowed"*) ;; *) printf '%s\\n' 'DIM permits only the authenticated workspace proposal namespace' >&2; exit 1 ;; esac
  proposal=\${ref#"$allowed"}
  case "$proposal" in ""|*[!A-Za-z0-9._/-]*|.*|*/.*|*..*|*//*|*.lock|*/|*.) printf '%s\\n' 'DIM proposal ref is unsafe' >&2; exit 1 ;; esac
  if [ "$new" = "$zero" ]; then printf '%s\\n' 'DIM proposal deletion is denied' >&2; exit 1; fi
  if [ "$old" != "$zero" ] && ! "$DIM_NATIVE_GIT_EXECUTABLE" merge-base --is-ancestor "$old" "$new"; then
    printf '%s\\n' 'DIM proposal force update is denied' >&2
    exit 1
  fi
done
`;

export async function assertGitVersion(config: Pick<NativeGitServiceConfig, "gitExecutable" | "gitVersion">): Promise<void> {
  const { stdout } = await execute(config.gitExecutable, ["--version"], { env: { LC_ALL: "C" } });
  if (stdout.trim() !== `git version ${config.gitVersion}`) {
    throw new NativeGitConfigError(`expected Git ${config.gitVersion}, received ${stdout.trim()}`);
  }
}

export async function initializeNativeRepository(
  config: Pick<NativeGitServiceConfig, "storageRoot" | "gitExecutable" | "gitVersion">,
  repository: NativeGitRepository
): Promise<string> {
  await assertGitVersion(config);
  const storageRoot = resolve(config.storageRoot);
  const projectRoot = join(storageRoot, repository.projectId);
  const repositoryPath = join(projectRoot, `${repository.repositoryId}.git`);
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  await assertOwnedDirectory(storageRoot, "storage root");
  await mkdir(projectRoot, { recursive: true, mode: 0o700 });
  await assertOwnedDirectory(projectRoot, "Project repository root");
  await chmod(projectRoot, 0o700);
  try {
    const stat = await lstat(repositoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new NativeGitConfigError("registered repository must be a directory");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await execute(config.gitExecutable, ["init", "--bare", "--initial-branch=main", repositoryPath], { env: { LC_ALL: "C" } });
  }
  await execute(config.gitExecutable, ["--git-dir", repositoryPath, "config", "http.receivepack", "true"], { env: { LC_ALL: "C" } });
  await execute(config.gitExecutable, ["--git-dir", repositoryPath, "config", "receive.denyNonFastForwards", "true"], { env: { LC_ALL: "C" } });
  const hookPath = join(repositoryPath, "hooks", "pre-receive");
  await writeFile(hookPath, hook, { mode: 0o700 });
  await chmod(hookPath, 0o700);
  await chmod(repositoryPath, 0o700);
  return repositoryPath;
}

export async function assertRegisteredRepository(storageRoot: string, repository: NativeGitRepository): Promise<void> {
  const root = await realpath(resolve(storageRoot));
  const repositoryPath = await realpath(join(root, repository.projectId, `${repository.repositoryId}.git`));
  const stat = await lstat(repositoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !repositoryPath.startsWith(`${root}${sep}`)) {
    throw new NativeGitConfigError("registered repository escapes the storage root");
  }
  const hookPath = join(repositoryPath, "hooks", "pre-receive");
  const hookStat = await lstat(hookPath);
  const hookBytes = await readFile(hookPath, "utf8");
  if (!hookStat.isFile() || hookStat.isSymbolicLink() || (hookStat.mode & 0o777) !== 0o700
    || hookBytes !== hook || dirname(hookPath) !== join(repositoryPath, "hooks")) {
    throw new NativeGitConfigError("registered repository policy hook is invalid");
  }
}

async function assertOwnedDirectory(path: string, label: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new NativeGitConfigError(`${label} must be a directory`);
  await chmod(path, 0o700);
}
