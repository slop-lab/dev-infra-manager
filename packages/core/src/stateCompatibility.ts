import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertCiRunnerRecord } from "./ciRunnerRecord.js";
import { UserError } from "./errors.js";
import { preflightHostLifecycleState } from "./hostStateMigration.js";
import { parseProjectRecord } from "./projectRecord.js";
import { assertWorkspaceRecord } from "./workspaceRecord.js";

export type StateCompatibilityResult = {
  readonly stateRoot: string;
  readonly warnings: readonly string[];
};

type StateFamily = "Project" | "workspace" | "CI runner";

export async function preflightStateCompatibility(
  env: NodeJS.ProcessEnv = process.env
): Promise<StateCompatibilityResult> {
  const stateRoot = path.resolve(
    env.DIM_STATE_ROOT ?? path.join(env.HOME ?? os.homedir(), ".local", "state", "dim")
  );
  if (!await inspectDirectory(stateRoot, "DIM state root", true)) return { stateRoot, warnings: [] };

  const hostResult = await inspectHost(stateRoot);
  await inspectFlatFamily(stateRoot, "projects", "Project", (value) => {
    parseProjectRecord(value);
  });
  await inspectFlatFamily(stateRoot, "workspaces", "workspace", assertWorkspaceRecord);
  await inspectCiRunners(stateRoot);

  return {
    stateRoot,
    warnings: hostResult.kind === "unchanged"
      ? []
      : ["Host lifecycle schema 1 is compatible and will be migrated with a permanent backup at controller startup."]
  };
}

async function inspectHost(stateRoot: string): Promise<{ readonly kind: "unchanged" | "migrated" | "recovered" }> {
  const target = path.join(stateRoot, "host.json");
  try {
    return await preflightHostLifecycleState(target);
  } catch (error) {
    throw compatibilityError("host lifecycle", target, error);
  }
}

async function inspectFlatFamily(
  stateRoot: string,
  directoryName: string,
  family: StateFamily,
  parse: (value: unknown, source: string) => void
): Promise<void> {
  const directory = path.join(stateRoot, directoryName);
  if (!await inspectDirectory(directory, `${family} state directory`, true)) return;
  for (const entry of await readdir(directory)) {
    if (!entry.endsWith(".json")) continue;
    const target = path.join(directory, entry);
    try {
      parse(await readJsonFile(target, `${family} state`), target);
    } catch (error) {
      throw compatibilityError(family, target, error);
    }
  }
}

async function inspectCiRunners(stateRoot: string): Promise<void> {
  const directory = path.join(stateRoot, "ci-runners");
  if (!await inspectDirectory(directory, "CI runner state directory", true)) return;
  for (const project of await readdir(directory)) {
    const projectDirectory = path.join(directory, project);
    try {
      await inspectDirectory(projectDirectory, `CI runner Project directory '${project}'`, false);
    } catch (error) {
      throw compatibilityError("CI runner", projectDirectory, error);
    }
    for (const entry of await readdir(projectDirectory)) {
      if (!entry.endsWith(".json")) continue;
      const target = path.join(projectDirectory, entry);
      try {
        const value = await readJsonFile(target, "CI runner state");
        assertCiRunnerRecord(value, target);
      } catch (error) {
        throw compatibilityError("CI runner", target, error);
      }
    }
  }
}

async function inspectDirectory(target: string, label: string, missingAllowed: boolean): Promise<boolean> {
  try {
    const metadata = await lstat(target);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new UserError(`${label} at '${target}' must be a directory, not a symlink or special file`);
    }
    return true;
  } catch (error) {
    if (missingAllowed && errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function readJsonFile(target: string, label: string): Promise<unknown> {
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new UserError(`${label} at '${target}' must be a regular file, not a symlink or special file`);
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new UserError(`${label} at '${target}' changed while it was inspected`);
    }
    try {
      return JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new UserError(`${label} at '${target}' is not valid JSON`);
      throw error;
    }
  } finally {
    await handle.close();
  }
}

function compatibilityError(family: string, target: string, error: unknown): UserError {
  const detail = error instanceof Error ? error.message : "state is invalid";
  return new UserError(
    `DIM installation compatibility preflight rejected ${family} state at '${target}': ${detail}. `
    + "Continue using the currently pinned DIM version to export needed data, then recreate the incompatible resource; no state was changed"
  );
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
