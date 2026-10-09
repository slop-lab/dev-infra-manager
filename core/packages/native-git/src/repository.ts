import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { NativeGitRepository, NativeGitServiceConfig } from "./config.js";
import { NativeGitConfigError } from "./config.js";
import { assertReviewStore, initializeReviewStore } from "./review-store.js";
import { assertStatusStore, initializeStatusStore } from "./status-store.js";
import { assertJobAttemptStore, initializeJobAttemptStore } from "./job-attempt-store.js";

const execute = promisify(execFile);
const gitMetadataProcessOptions = { maxBuffer: 4096, timeout: 10_000 } as const;
const hook = `#!/bin/sh
set -eu
workspace="\${DIM_NATIVE_GIT_WORKSPACE_ID-}"
case "$workspace" in
  ""|*[!A-Za-z0-9_-]*) printf '%s\\n' 'DIM proposal identity is invalid' >&2; exit 1 ;;
esac
allowed="refs/heads/proposals/$workspace/"
while IFS=' ' read -r old new ref; do
  case "$ref" in "$allowed"*) ;; *) printf '%s\\n' 'DIM permits only the authenticated workspace proposal namespace' >&2; exit 1 ;; esac
  proposal=\${ref#"$allowed"}
  case "$proposal" in ""|*[!A-Za-z0-9._/-]*|.*|*/.*|*..*|*//*|*.lock|*/|*.) printf '%s\\n' 'DIM proposal ref is unsafe' >&2; exit 1 ;; esac
  case "$new" in *[!0]*) ;; *) printf '%s\\n' 'DIM proposal deletion is denied' >&2; exit 1 ;; esac
done
`;

export type GitExecutableIdentity = {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly owner: bigint;
  readonly size: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
};

type GitConfig = Pick<NativeGitServiceConfig, "gitExecutable" | "gitVersion">;

export async function assertGitVersion(config: GitConfig): Promise<GitExecutableIdentity> {
  const identity = await inspectGitExecutable(config.gitExecutable);
  const { stdout } = await execute(config.gitExecutable, ["--version"], {
    env: { GIT_CONFIG_NOSYSTEM: "1", HOME: "/dev/null", LC_ALL: "C" },
    ...gitMetadataProcessOptions
  });
  if (stdout.trim() !== `git version ${config.gitVersion}`) {
    throw new NativeGitConfigError(`expected Git ${config.gitVersion}, received ${stdout.trim()}`);
  }
  return identity;
}

export async function assertGitExecutableIdentity(path: string, expected: GitExecutableIdentity): Promise<void> {
  const actual = await inspectGitExecutable(path);
  if (actual.device !== expected.device || actual.inode !== expected.inode || actual.mode !== expected.mode
    || actual.owner !== expected.owner || actual.size !== expected.size || actual.modified !== expected.modified
    || actual.changed !== expected.changed) {
    throw new NativeGitConfigError("configured Git executable changed after startup validation");
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
  await assertTrustedDirectoryChain(dirname(storageRoot));
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
  await execute(config.gitExecutable, ["--git-dir", repositoryPath, "config", "receive.fsckObjects", "true"], { env: { LC_ALL: "C" } });
  await execute(config.gitExecutable, ["--git-dir", repositoryPath, "config", "receive.fsck.fullPathname", "error"], { env: { LC_ALL: "C" } });
  const hooksPath = join(repositoryPath, "hooks");
  await execute(config.gitExecutable, ["--git-dir", repositoryPath, "config", "core.hooksPath", hooksPath], { env: { LC_ALL: "C" } });
  await assertOwnedDirectory(hooksPath, "repository hooks directory");
  const hookPath = join(hooksPath, "pre-receive");
  const hookFile = await open(hookPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o700)
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ELOOP") {
        throw new NativeGitConfigError("registered repository policy hook must not be a symbolic link");
      }
      throw error;
    });
  try {
    await hookFile.writeFile(hook);
    await hookFile.chmod(0o700);
  } finally {
    await hookFile.close();
  }
  await chmod(repositoryPath, 0o700);
  await initializeReviewStore(repositoryPath);
  await initializeStatusStore(repositoryPath);
  await initializeJobAttemptStore(repositoryPath);
  return repositoryPath;
}

export async function assertRegisteredRepository(
  config: Pick<NativeGitServiceConfig, "storageRoot" | "gitExecutable">,
  repository: NativeGitRepository
): Promise<void> {
  const root = resolve(config.storageRoot);
  const projectRoot = join(root, repository.projectId);
  const repositoryPath = join(projectRoot, `${repository.repositoryId}.git`);
  await assertTrustedDirectoryChain(root);
  await assertDirectory(projectRoot, "Project repository root");
  await assertDirectory(repositoryPath, "registered repository");
  if (!repositoryPath.startsWith(`${root}${sep}`)) throw new NativeGitConfigError("registered repository escapes the storage root");
  const hooksPath = join(repositoryPath, "hooks");
  await assertDirectory(hooksPath, "repository hooks directory");
  const hookPath = join(hooksPath, "pre-receive");
  const hookStat = await lstat(hookPath);
  const hookBytes = await readFile(hookPath, "utf8");
  if (!hookStat.isFile() || hookStat.isSymbolicLink() || (hookStat.mode & 0o777) !== 0o700
    || hookBytes !== hook || dirname(hookPath) !== join(repositoryPath, "hooks")) {
    throw new NativeGitConfigError("registered repository policy hook is invalid");
  }
  const { stdout } = await execute(config.gitExecutable, ["--git-dir", repositoryPath, "config", "--path", "--get", "core.hooksPath"], {
    env: { GIT_CONFIG_NOSYSTEM: "1", HOME: "/dev/null", LC_ALL: "C" }
  });
  if (stdout.trim() !== hooksPath) throw new NativeGitConfigError("registered repository hooks path is invalid");
  const fsck = await execute(config.gitExecutable, ["--git-dir", repositoryPath, "config", "--bool", "--get", "receive.fsckObjects"], {
    env: { GIT_CONFIG_NOSYSTEM: "1", HOME: "/dev/null", LC_ALL: "C" },
    ...gitMetadataProcessOptions
  });
  if (fsck.stdout.trim() !== "true") throw new NativeGitConfigError("registered repository receive fsck policy is invalid");
  const fullPathname = await execute(config.gitExecutable, ["--git-dir", repositoryPath, "config", "--get", "receive.fsck.fullPathname"], {
    env: { GIT_CONFIG_NOSYSTEM: "1", HOME: "/dev/null", LC_ALL: "C" },
    ...gitMetadataProcessOptions
  });
  if (fullPathname.stdout.trim() !== "error") throw new NativeGitConfigError("registered repository pathname fsck policy is invalid");
  await assertReviewStore(repositoryPath);
  await assertStatusStore(repositoryPath);
  await assertJobAttemptStore(repositoryPath);
}

async function assertOwnedDirectory(path: string, label: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== serviceUid()) {
    throw new NativeGitConfigError(`${label} must be a caller-owned directory`);
  }
  await chmod(path, 0o700);
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new NativeGitConfigError(`${label} must not be a symbolic link`);
  if (!stat.isDirectory()) throw new NativeGitConfigError(`${label} must be a directory`);
}

async function assertTrustedDirectoryChain(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(sep).filter((value) => value.length > 0)) {
    current = join(current, component);
    const stat = await lstat(current, { bigint: true });
    const stickyRootDirectory = stat.uid === 0n && (stat.mode & 0o1000n) !== 0n;
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.uid !== 0n && stat.uid !== BigInt(serviceUid()))
      || ((stat.mode & 0o022n) !== 0n && !stickyRootDirectory)) {
      throw new NativeGitConfigError(`untrusted directory in configured path: ${current}`);
    }
  }
}

async function inspectGitExecutable(path: string): Promise<GitExecutableIdentity> {
  if (resolve(path) !== path) throw new NativeGitConfigError("configured Git executable path must be canonical");
  await assertTrustedDirectoryChain(dirname(path));
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o111n) === 0n
    || (stat.mode & 0o022n) !== 0n || (stat.uid !== 0n && stat.uid !== BigInt(serviceUid()))) {
    throw new NativeGitConfigError("configured Git executable must be a trusted executable regular file");
  }
  return {
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    owner: stat.uid,
    size: stat.size,
    modified: stat.mtimeNs,
    changed: stat.ctimeNs
  };
}

function serviceUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new NativeGitConfigError("native Git requires a Linux user identity");
  return uid;
}
