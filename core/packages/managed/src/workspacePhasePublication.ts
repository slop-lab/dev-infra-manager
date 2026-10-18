import type { LifecycleState } from "./lifecycleState.js";
import type { WorkspaceRecord } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "@slop-lab/dim-core";
import { notifyRecommendedWorkspaceRelayPhase } from "./workspaceAgentLifecycle.js";
import { combineWorkspaceLifecycleFailures } from "./workspaceLifecycleError.js";

type WorkspacePhasePublication = {
  readonly runner: StreamingCommandRunner;
  readonly state: LifecycleState;
  readonly record: WorkspaceRecord;
  readonly containerId?: string;
  readonly notifyRelay: boolean;
};

export async function publishWorkspacePhase(input: WorkspacePhasePublication): Promise<void> {
  let notificationError: unknown;
  if (input.notifyRelay && input.containerId !== undefined && input.record.phase !== "ready") {
    try {
      await notifyRecommendedWorkspaceRelayPhase(
        input.runner,
        input.record,
        input.containerId,
        input.record.phase
      );
    } catch (error) {
      notificationError = error;
    }
  }
  try {
    await input.state.writeWorkspace(input.record);
  } catch (publicationError) {
    if (notificationError !== undefined) {
      throw combineWorkspaceLifecycleFailures(notificationError, publicationError);
    }
    throw publicationError;
  }
  if (notificationError !== undefined) throw notificationError;
  if (input.notifyRelay && input.containerId !== undefined && input.record.phase === "ready") {
    await notifyRecommendedWorkspaceRelayPhase(input.runner, input.record, input.containerId, "ready");
  }
}
