import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { errorCode, readStateFile } from "./controlPlaneStateFs.js";

const runnerRecordMaximumBytes = 64 * 1024;
const lifecycleName = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const runnerPhases = new Set(["creating", "ready", "stopped", "error"]);

export async function preflightControlPlanePredecessor(
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (environment.DIM_ORDINARY_CI_POOL_CONNECTION_FILE !== undefined) {
    throw new ControlPlanePredecessorError(
      "DIM_ORDINARY_CI_POOL_CONNECTION_FILE selects the obsolete ordinary-CI pool and must be removed before control-plane installation"
    );
  }
  const stateRoot = resolve(
    environment.DIM_STATE_ROOT ?? join(environment.HOME ?? homedir(), ".local", "state", "dim")
  );
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
      const runnerName = basename(entry.name, ".json");
      if (!entry.isFile() || entry.isSymbolicLink() || !lifecycleName.test(runnerName)) {
        throw new ControlPlanePredecessorError(
          `canonical CI runner record '${join(projectRoot, entry.name)}' is a symbolic link, non-regular file, or has an invalid name`
        );
      }
      await classifyRunnerRecord(join(projectRoot, entry.name), project.name, runnerName);
    }
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

async function classifyRunnerRecord(target: string, projectName: string, runnerName: string): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await readStateFile(target, 0o600, runnerRecordMaximumBytes);
  } catch (error) {
    throw new ControlPlanePredecessorError(
      `canonical CI runner record '${target}' is unreadable or has invalid ownership, mode, type, links, or size`,
      { cause: error }
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ControlPlanePredecessorError(`canonical CI runner record '${target}' is not valid JSON`, { cause: error });
    }
    throw error;
  }
  const kind = parseRunnerKind(value, projectName, runnerName);
  if (kind === "sysbox") {
    throw new ControlPlanePredecessorError(
      `Project-scoped Sysbox CI runner state at '${target}' is unsupported; stop and remove it with the pinned predecessor release`
    );
  }
}

function parseRunnerKind(value: unknown, projectName: string, runnerName: string): "sysbox" | "qemu" {
  if (!isRecord(value) || value.schemaVersion !== 8 || value.name !== runnerName
    || value.projectName !== projectName || !strings(value, ["projectId", "provider", "createdAt", "updatedAt"])
    || !isConfig(value.config) || !isRecord(value.executor)) {
    throw unsupportedRunner(projectName, runnerName);
  }
  const executor = value.executor;
  if (typeof executor.phase !== "string" || !runnerPhases.has(executor.phase)
    || !strings(executor, ["volumeName", "image", "updatedAt"])
    || typeof executor.inheritsResources !== "boolean" || !isStringArray(executor.labels)
    || !optionalString(executor.error)) {
    throw unsupportedRunner(projectName, runnerName);
  }
  if (executor.kind === "sysbox") {
    if (!strings(executor, ["containerName", "runtime"]) || !isResources(executor.resources, true)
      || !optionalString(executor.providerRunnerName)) throw unsupportedRunner(projectName, runnerName);
    return "sysbox";
  }
  if (executor.kind === "qemu") {
    if (!strings(executor, ["supervisorName", "jobImage"]) || !isResources(executor.resources, false)
      || !isProjectHook(executor.projectHook) || !isScheduler(executor.scheduler)) {
      throw unsupportedRunner(projectName, runnerName);
    }
    return "qemu";
  }
  throw unsupportedRunner(projectName, runnerName);
}

function isConfig(value: unknown): boolean {
  return isRecord(value) && strings(value, ["sourceRef", "sourceCommit", "configDigest"]);
}

function isResources(value: unknown, requirePids: boolean): boolean {
  return isRecord(value) && strings(value, requirePids ? ["cpus", "memory", "pidsLimit"] : ["cpus", "memory"]);
}

function isProjectHook(value: unknown): boolean {
  return isRecord(value) && strings(value, ["sourceRef", "sourceCommit", "digest"])
    && (value.kind === "present" || value.kind === "absent");
}

function isScheduler(value: unknown): boolean {
  return value === undefined || (isRecord(value) && strings(value, ["projectId", "hostId"]));
}

function strings(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof value[field] === "string");
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupportedRunner(projectName: string, runnerName: string): ControlPlanePredecessorError {
  return new ControlPlanePredecessorError(
    `canonical CI runner '${projectName}/${runnerName}' is malformed, unsupported, or cannot be classified as schema-8 QEMU state`
  );
}

function byName(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name.localeCompare(right.name);
}

export class ControlPlanePredecessorError extends Error {
  readonly name = "ControlPlanePredecessorError";
}
