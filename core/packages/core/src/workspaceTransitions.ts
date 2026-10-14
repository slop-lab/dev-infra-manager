import { requireNativeControlPlaneConnection } from "./lifecycleOptions.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import type { LifecycleOptions, WorkspaceRecord } from "./lifecycleTypes.js";
import { transitionNativeWorkspace } from "./nativeWorkspaceTransitions.js";
import type { StreamingCommandRunner } from "./types.js";
import { runWorkspaceLifecycle } from "./workspaceLifecycleError.js";
import { assertWorkspaceLifecycleActive } from "./workspaceRecord.js";

export async function updateWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string,
  profiles?: string[]
): Promise<WorkspaceRecord> {
  requireNativeControlPlaneConnection(options);
  return transition("update", runner, options, name, profiles);
}

export async function startWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string
): Promise<WorkspaceRecord> {
  requireNativeControlPlaneConnection(options);
  return transition("start", runner, options, name);
}

export async function restartWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string
): Promise<WorkspaceRecord> {
  requireNativeControlPlaneConnection(options);
  return transition("restart", runner, options, name);
}

function transition(
  operation: "start" | "update" | "restart",
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string,
  profiles?: string[]
): Promise<WorkspaceRecord> {
  return runWorkspaceLifecycle(operation, async (setStage, setErrorStage) => {
    const state = new LifecycleState(options.stateRoot);
    setStage("workspace state loading");
    const initial = await state.readWorkspace(validateLifecycleName(name, "workspace"));
    assertWorkspaceLifecycleActive(initial);
    return transitionNativeWorkspace({
      operation,
      runner,
      options,
      initial,
      ...(profiles === undefined ? {} : { profiles }),
      setStage,
      setErrorStage
    });
  });
}
