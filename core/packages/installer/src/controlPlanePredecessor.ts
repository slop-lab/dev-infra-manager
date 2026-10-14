import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { errorCode } from "./controlPlaneStateFs.js";

const lifecycleName = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const predecessorSelectors = [
  "DIM_GITEA_CONNECTION_FILE",
  "DIM_GIT_SYNC_CONNECTION_FILE",
  "DIM_QEMU_SCHEDULER_CONNECTION_FILE",
  "DIM_ORDINARY_CI_POOL_CONNECTION_FILE"
] as const;

export async function preflightControlPlanePredecessor(
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const selected = predecessorSelectors.find((name) => environment[name] !== undefined);
  if (selected !== undefined) {
    throw new ControlPlanePredecessorError(
      `${selected} selects removed predecessor infrastructure and must be removed before control-plane installation`
    );
  }
  const stateRoot = resolve(
    environment.DIM_STATE_ROOT ?? join(environment.HOME ?? homedir(), ".local", "state", "dim")
  );
  const giteaState = join(stateRoot, "services", "gitea.json");
  if (await canonicalPathExists(giteaState)) {
    throw new ControlPlanePredecessorError(
      `canonical managed Gitea state at '${giteaState}' is unsupported; remove it with the pinned predecessor release`
    );
  }
  const runnersRoot = join(stateRoot, "ci-runners");
  if (!await privateDirectoryExists(runnersRoot, true)) return;

  for (const project of (await readdir(runnersRoot, { withFileTypes: true })).sort(byName)) {
    if (!project.isDirectory() || project.isSymbolicLink() || !lifecycleName.test(project.name)) {
      throw new ControlPlanePredecessorError(`canonical CI runner Project entry '${project.name}' is unsafe or invalid`);
    }
    const projectRoot = join(runnersRoot, project.name);
    await privateDirectoryExists(projectRoot, false);
    for (const entry of (await readdir(projectRoot, { withFileTypes: true })).sort(byName)) {
      if (!entry.name.endsWith(".json")) continue;
      const runnerName = entry.name.slice(0, -".json".length);
      const target = join(projectRoot, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink() || !lifecycleName.test(runnerName)) {
        throw new ControlPlanePredecessorError(
          `canonical CI runner record '${target}' is a symbolic link, non-regular file, or has an invalid name`
        );
      }
      throw new ControlPlanePredecessorError(
        `Project-scoped CI runner state at '${target}' is unsupported; remove it with the pinned predecessor release`
      );
    }
  }
}

async function canonicalPathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw new ControlPlanePredecessorError(`cannot inspect canonical predecessor state '${target}'`, { cause: error });
  }
}

async function privateDirectoryExists(target: string, missingAllowed: boolean): Promise<boolean> {
  let metadata;
  try {
    metadata = await lstat(target, { bigint: true });
  } catch (error) {
    if (missingAllowed && errorCode(error) === "ENOENT") return false;
    throw new ControlPlanePredecessorError(`cannot inspect canonical CI runner directory '${target}'`, { cause: error });
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new ControlPlanePredecessorError("control-plane predecessor preflight requires a Linux user identity");
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== BigInt(uid)
    || Number(metadata.mode & 0o777n) !== 0o700) {
    throw new ControlPlanePredecessorError(`canonical CI runner directory '${target}' must be caller-owned mode 0700`);
  }
  return true;
}

function byName(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name.localeCompare(right.name);
}

export class ControlPlanePredecessorError extends Error {
  readonly name = "ControlPlanePredecessorError";
}
