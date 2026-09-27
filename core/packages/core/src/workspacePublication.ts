import { LifecycleState } from "./lifecycleState.js";
import type { WorkspaceRecord } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";
import { writeProjectManifest } from "./workspaceRepositorySnapshot.js";
import type { WorkspacePublicationTarget } from "./workspaceLifecycleTypes.js";

export async function recordSelectedRoot(
  state: LifecycleState,
  record: WorkspaceRecord,
  target: WorkspacePublicationTarget
): Promise<WorkspaceRecord> {
  const updating = {
    ...record,
    rootRef: target.rootRef,
    rootCommit: target.rootCommit,
    phase: "setting-up" as const,
    updatedAt: new Date().toISOString()
  };
  delete updating.error;
  await state.writeWorkspace(updating);
  return updating;
}

export async function applySelectedRoot(input: {
  readonly runner: StreamingCommandRunner;
  readonly state: LifecycleState;
  readonly record: WorkspaceRecord;
  readonly target: WorkspacePublicationTarget;
  readonly containerId: string;
}): Promise<WorkspaceRecord> {
  const updating = await recordSelectedRoot(input.state, input.record, input.target);
  const runtimeRecord = { ...input.record, containerName: input.containerId };
  try {
    await writeProjectManifest(input.runner, { ...updating, containerName: runtimeRecord.containerName });
    return updating;
  } catch (error) {
    await input.state.writeWorkspace({
      ...updating,
      phase: "setup-error",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString()
    });
    throw error;
  }
}
