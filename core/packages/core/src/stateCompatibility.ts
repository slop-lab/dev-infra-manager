import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UserError } from "./errors.js";
import { inspectStateDirectory, readStateJsonFile } from "./stateInspection.js";
import { parseWorkspaceRecord } from "./workspace/store.js";

export type StateCompatibilityResult = {
  readonly stateRoot: string;
  readonly warnings: readonly string[];
};

/** Installation validates only state owned by the base workspace application. */
export async function preflightStateCompatibility(
  env: NodeJS.ProcessEnv = process.env
): Promise<StateCompatibilityResult> {
  const stateRoot = path.resolve(env.DIM_STATE_ROOT ?? path.join(env.HOME ?? os.homedir(), ".local", "state", "dim"));
  if (!await inspectStateDirectory(stateRoot, "DIM state root", true)) return { stateRoot, warnings: [] };
  const directory = path.join(stateRoot, "workspaces");
  if (!await inspectStateDirectory(directory, "workspace state directory", true)) return { stateRoot, warnings: [] };
  for (const entry of await readdir(directory)) {
    if (!entry.endsWith(".json")) continue;
    const target = path.join(directory, entry);
    try {
      const record = parseWorkspaceRecord(await readStateJsonFile(target, "workspace state"));
      if (record.name !== entry.slice(0, -5)) throw new UserError("workspace state filename differs from its recorded name");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "state is invalid";
      throw new UserError(`DIM installation preflight rejected workspace state at '${target}': ${detail}. `
        + "Export needed data with the currently installed DIM version before recreating incompatible resources; no state was changed", { cause: error });
    }
  }
  return { stateRoot, warnings: [] };
}
