import type { LifecycleEnvironment } from "./environment.js";
import { parseWorkspaceList, type WorkspaceView } from "./inspect.js";

export class CleanupSafetyError extends Error {
  readonly name = "CleanupSafetyError";
  constructor(readonly evidenceRoot: string, reason: string) {
    super(`owned cleanup refused: ${reason}; private evidence retained`);
  }
}

export function selectCleanupIdentity(rows: readonly WorkspaceView[], name: string, knownId: string | undefined): string | undefined {
  const unexpected = rows.filter((row) => row.name !== name);
  if (unexpected.length > 0) throw new CleanupSafetyError("private-state", "unexpected workspace exists in the initially empty store");
  const matches = rows.filter((row) => row.name === name);
  if (matches.length > 1) throw new CleanupSafetyError("private-state", "duplicate owned workspace records exist");
  const discovered = matches[0]?.id;
  if (knownId !== undefined && discovered !== undefined && discovered !== knownId) {
    throw new CleanupSafetyError("private-state", "workspace identity changed after selection");
  }
  return discovered ?? knownId;
}

export async function cleanupOwnedWorkspace(environment: LifecycleEnvironment, knownId: string | undefined): Promise<void> {
  const rows = parseWorkspaceList((await environment.cli(["ls", "--json"])).stdout);
  let id: string | undefined;
  try {
    id = selectCleanupIdentity(rows, environment.name, knownId);
  } catch (error) {
    if (error instanceof CleanupSafetyError) throw new CleanupSafetyError(environment.root, error.message);
    throw error;
  }
  if (id === undefined || rows.length === 0) return;
  await environment.cli(["discard", environment.name, "--yes", "--expect-id", id, "--json"]);
}
