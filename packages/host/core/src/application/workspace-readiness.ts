import { UserError } from "../errors.js";
import type { WorkspaceRecord } from "../workspace/models.js";
import type { WorkspaceStore } from "../workspace/store.js";

export const workspacePreparationFailurePrefix = "Integration preparation failed: ";

export async function prepareWorkspaceReadiness(workspace: WorkspaceRecord, store: WorkspaceStore, prepare: () => Promise<void>): Promise<void> {
  const before = await store.read(workspace.name);
  if (before.id !== workspace.id || before.phase !== "running") throw new UserError("workspace changed before integration preparation");
  try { await prepare(); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const running = await store.withLock(workspace.name, async () => {
      const current = await store.read(workspace.name);
      if (current.id === workspace.id && current.phase === "running" && current.updatedAt === before.updatedAt) {
        await store.write({ ...current, error: `${workspacePreparationFailurePrefix}${detail}`, updatedAt: new Date().toISOString() });
        return true;
      }
      return false;
    }).catch((recordError: unknown) => { throw new AggregateError([error, recordError], `workspace '${workspace.name}' integration preparation failed and its diagnostic could not be recorded: ${detail}`); });
    throw new UserError(`workspace '${workspace.name}' ${running ? "runtime remains running" : "changed during preparation"}; integration preparation failed: ${detail}`, { cause: error });
  }
  await store.withLock(workspace.name, async () => {
    const current = await store.read(workspace.name);
    if (current.id !== workspace.id || current.phase !== "running" || current.updatedAt !== before.updatedAt) throw new UserError("workspace changed during integration preparation");
    if (current.error === before.error && current.error?.startsWith(workspacePreparationFailurePrefix)) {
      const { error: _error, ...ready } = current;
      await store.write({ ...ready, updatedAt: new Date().toISOString() });
    }
  });
}
