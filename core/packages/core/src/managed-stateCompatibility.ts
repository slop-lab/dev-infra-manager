import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UserError } from "./errors.js";
import { inspectStateDirectory, readStateJsonFile } from "./stateInspection.js";
import { parseHostLifecycleRecord } from "./hostLifecycleRecord.js";
import { parseProjectRecord } from "./projectRecord.js";
import { assertWorkspaceRecord } from "./workspaceRecord.js";

export type ManagedStateCompatibilityResult = {
  readonly stateRoot: string;
  readonly warnings: readonly string[];
};

type StateFamily = "Project" | "workspace";

export async function preflightManagedStateCompatibility(
  env: NodeJS.ProcessEnv = process.env
): Promise<ManagedStateCompatibilityResult> {
  const stateRoot = path.resolve(
    env.DIM_STATE_ROOT ?? path.join(env.HOME ?? os.homedir(), ".local", "state", "dim")
  );
  if (!await inspectStateDirectory(stateRoot, "DIM state root", true)) return { stateRoot, warnings: [] };

  await inspectHost(stateRoot);
  await inspectFlatFamily(stateRoot, "projects", "Project", (value) => {
    parseProjectRecord(value);
  });
  await inspectFlatFamily(stateRoot, "workspaces", "workspace", assertWorkspaceRecord);
  return { stateRoot, warnings: [] };
}

async function inspectHost(stateRoot: string): Promise<void> {
  const target = path.join(stateRoot, "host.json");
  try {
    parseHostLifecycleRecord(await readStateJsonFile(target, "host lifecycle state"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
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
  if (!await inspectStateDirectory(directory, `${family} state directory`, true)) return;
  for (const entry of await readdir(directory)) {
    if (!entry.endsWith(".json")) continue;
    const target = path.join(directory, entry);
    try {
      parse(await readStateJsonFile(target, `${family} state`), target);
    } catch (error) {
      throw compatibilityError(family, target, error);
    }
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
