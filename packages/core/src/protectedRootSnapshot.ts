import { chmod, lstat, mkdir, mkdtemp, readlink, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { ensureGitea } from "./gitea.js";
import { UserError } from "./errors.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import { resolveProtectedRoot } from "./protectedRootResolution.js";
import type {
  GiteaCredentials,
  LifecycleOptions,
  ProjectRecord,
  ProjectRepositoryRecord
} from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";

const RESERVED_LIFECYCLE_PATHS = [
  ".dim",
  ".dim/setup.sh",
  ".dim/entrypoint.sh",
  ".dim/teardown.sh",
  ".dim/docker-compose.yml"
] as const;

export type ProtectedRootSnapshot = {
  readonly project: ProjectRecord;
  readonly repository: ProjectRepositoryRecord;
  readonly rootRequestedRef: string;
  readonly rootRef: string;
  readonly rootCommit: string;
  readonly rootSnapshotPath: string;
};

export type ProtectedRootSnapshotRequest = {
  readonly runner: StreamingCommandRunner;
  readonly options: LifecycleOptions;
  readonly projectName: string;
  readonly credentials?: GiteaCredentials;
};

export type LockedProtectedRootSnapshotRequest = Omit<ProtectedRootSnapshotRequest, "projectName"> & {
  readonly project: ProjectRecord;
};

export async function removeProtectedRootSnapshots(stateRoot: string, projectId: string): Promise<void> {
  if (!/^[A-Za-z0-9-]+$/.test(projectId)) throw new UserError(`project ID '${projectId}' is invalid`);
  const root = path.join(stateRoot, "assets", "project-roots", projectId);
  try {
    await makeDirectoriesWritable(root);
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export async function resolveProtectedRootSnapshot(
  request: ProtectedRootSnapshotRequest
): Promise<ProtectedRootSnapshot> {
  const projectName = validateLifecycleName(request.projectName, "project");
  const state = new LifecycleState(request.options.stateRoot);
  const release = await state.acquireProjectLock(projectName);
  try {
    const project = await state.readProject(projectName);
    return await resolveProtectedRootSnapshotLocked({
      runner: request.runner,
      options: request.options,
      project,
      ...(request.credentials === undefined ? {} : { credentials: request.credentials })
    });
  } finally {
    await release();
  }
}

export async function resolveProtectedRootSnapshotLocked(
  request: LockedProtectedRootSnapshotRequest
): Promise<ProtectedRootSnapshot> {
  const projectName = validateLifecycleName(request.project.name, "project");
  if (request.project.phase !== "ready") {
    throw new UserError(`project '${projectName}' is not ready (phase: ${request.project.phase})`);
  }
  const credentials = request.credentials ?? await ensureGitea(request.runner, request.options);
  const resolved = await resolveProtectedRoot(request.runner, request.project, credentials);
  const rootSnapshotPath = await publishRootSnapshot({
    runner: request.runner,
    stateRoot: request.options.stateRoot,
    project: request.project,
    repository: resolved.repository,
    commit: resolved.commit,
    credentials
  });
  return {
    project: request.project,
    repository: resolved.repository,
    rootRequestedRef: resolved.requestedRef,
    rootRef: resolved.ref,
    rootCommit: resolved.commit,
    rootSnapshotPath
  };
}

async function publishRootSnapshot(
  input: {
    readonly runner: StreamingCommandRunner;
    readonly stateRoot: string;
    readonly project: ProjectRecord;
    readonly repository: ProjectRepositoryRecord;
    readonly commit: string;
    readonly credentials: GiteaCredentials;
  }
): Promise<string> {
  const parent = path.join(input.stateRoot, "assets", "project-roots", input.project.id);
  const target = path.join(parent, input.commit);
  try {
    if ((await lstat(target)).isDirectory()) return target;
    throw new UserError(`protected root snapshot '${target}' is not a directory`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(parent, ".staging-"));
  const checkout = path.join(staging, "tree");
  try {
    const cloned = await input.runner.run("git", ["clone", "--no-checkout", "--filter=blob:none", "--no-tags", input.repository.hostUrl, checkout], {
      env: gitEnvironment(input.credentials)
    });
    if (cloned.exitCode !== 0) throw commandError(`clone protected root '${input.project.name}'`, cloned);
    const fetched = await input.runner.run("git", ["-C", checkout, "fetch", "--no-tags", "origin", input.commit], {
      env: gitEnvironment(input.credentials)
    });
    if (fetched.exitCode !== 0) throw commandError(`fetch protected root commit '${input.commit}'`, fetched);
    const checkedOut = await input.runner.run("git", ["-C", checkout, "checkout", "--detach", input.commit]);
    if (checkedOut.exitCode !== 0) throw commandError(`check out protected root commit '${input.commit}'`, checkedOut);
    await rm(path.join(checkout, ".git"), { recursive: true, force: true });
    await validateSnapshotLinks(checkout);
    await makeSnapshotReadOnly(checkout);
    await rename(checkout, target);
    return target;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function validateSnapshotLinks(root: string): Promise<void> {
  for (const relative of RESERVED_LIFECYCLE_PATHS) {
    try {
      if ((await lstat(path.join(root, relative))).isSymbolicLink()) {
        throw new UserError(`reserved lifecycle path '${relative}' must not be a symbolic link`);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  await walkSnapshot(root, async (entry) => {
    const metadata = await lstat(entry);
    if (!metadata.isSymbolicLink()) return;
    if (path.isAbsolute(await readlink(entry))) {
      throw new UserError(`protected root snapshot contains an absolute symbolic link '${path.relative(root, entry)}'`);
    }
    let resolved: string;
    try {
      resolved = await realpath(entry);
    } catch {
      throw new UserError(`protected root snapshot contains an invalid symbolic link '${path.relative(root, entry)}'`);
    }
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new UserError(`protected root snapshot symbolic link '${path.relative(root, entry)}' escapes the snapshot`);
    }
  });
}

async function makeSnapshotReadOnly(root: string): Promise<void> {
  await walkSnapshot(root, async (entry) => {
    const metadata = await lstat(entry);
    if (!metadata.isSymbolicLink()) await chmod(entry, metadata.mode & 0o555);
  });
  await chmod(root, 0o555);
}

async function makeDirectoriesWritable(root: string): Promise<void> {
  const metadata = await lstat(root);
  if (!metadata.isDirectory()) return;
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeDirectoriesWritable(path.join(root, entry.name));
  }
}

async function walkSnapshot(root: string, visit: (entry: string) => Promise<void>): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    await visit(target);
    if (entry.isDirectory()) await walkSnapshot(target, visit);
  }
}

function gitEnvironment(credentials: GiteaCredentials): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DIM_GIT_USERNAME: credentials.writerUsername,
    DIM_GIT_TOKEN: credentials.writerPassword,
    GIT_TERMINAL_PROMPT: "0"
  };
}

function commandError(action: string, result: { readonly stderr: string; readonly stdout: string }): UserError {
  return new UserError(`failed to ${action}: ${(result.stderr || result.stdout).trim()}`);
}
