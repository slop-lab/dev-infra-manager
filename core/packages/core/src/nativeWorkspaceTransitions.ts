import { isDeepStrictEqual } from "node:util";
import { UserError } from "./errors.js";
import { LifecycleState } from "./lifecycleState.js";
import type { LifecycleOptions, NativeWorkspaceRecord, WorkspaceRecord } from "./lifecycleTypes.js";
import { selectCurrentNativeWorkspaceRoot } from "./nativeWorkspaceSelection.js";
import type { StreamingCommandRunner } from "./types.js";
import { assertContainerRunning } from "./workspaceContainer.js";
import { runWorkspaceLifecycleStage, type SetWorkspaceLifecycleErrorStage,
  type SetWorkspaceLifecycleStage } from "./workspaceLifecycleError.js";
import { assertWorkspaceLifecycleActive } from "./workspaceRecord.js";
import { reconcileNativeWorkspace, setupWorkspaceLocked } from "./workspaceSetup.js";
import { reconcileWorkspaceRuntimeState, stopWorkspaceLocked } from "./workspaceState.js";
import { readWorkspaceForOperation, validateWorkspaceProfiles } from "./workspaceValidation.js";

type NativeTransitionInput = {
  readonly operation: "start" | "update" | "restart";
  readonly runner: StreamingCommandRunner;
  readonly options: LifecycleOptions;
  readonly initial: NativeWorkspaceRecord;
  readonly profiles?: string[];
  readonly setStage: SetWorkspaceLifecycleStage;
  readonly setErrorStage: SetWorkspaceLifecycleErrorStage;
  readonly recovery?: true;
};

export async function recoverNativeWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  initial: NativeWorkspaceRecord
): Promise<WorkspaceRecord> {
  return transitionNativeWorkspace({
    operation: "restart",
    runner,
    options,
    initial,
    recovery: true,
    setStage: () => undefined,
    setErrorStage: () => undefined
  });
}

export async function transitionNativeWorkspace(input: NativeTransitionInput): Promise<WorkspaceRecord> {
  const state = new LifecycleState(input.options.stateRoot);
  input.setStage("Project lock acquisition");
  const releaseProject = await state.acquireProjectLock(input.initial.projectName);
  try {
    input.setStage("native readiness and protected root selection");
    const selected = await selectCurrentNativeWorkspaceRoot(input.options, input.initial);
    input.setStage("workspace setup lock acquisition");
    const releaseSetup = await state.acquireWorkspaceSetupLock(input.initial.name);
    try {
      let current = await readCurrent(state, input);
      if (input.operation === "update") {
        const nextProfiles = input.profiles === undefined
          ? current.profiles
          : validateWorkspaceProfiles(input.profiles);
        input.setStage("workspace container readiness");
        await assertContainerRunning(input.runner, input.options.stateRoot, current);
        current = applySelection(current, selected, nextProfiles);
        input.setStage("workspace state publication");
        await state.writeWorkspace(current);
        const reconciled = await reconcileNativeWorkspace(
          input.runner, input.options, state, current, input.setStage
        );
        return setupWorkspaceLocked(input.runner, input.options, state, reconciled,
          !isDeepStrictEqual(input.initial.profiles, nextProfiles), false,
          input.setStage, input.setErrorStage);
      }
      input.setStage("workspace runtime reconciliation");
      current = requireNative(await reconcileWorkspaceRuntimeState(
        input.runner, state, input.options.stateRoot, current
      ));
      if (input.recovery === true) {
        switch (current.phase) {
          case "ready":
            return current;
          case "stopped":
          case "setting-up":
          case "setup-error":
          case "error":
            break;
          case "creating":
            throw new UserError(`workspace '${current.name}' is still creating and cannot be recovered by host start`);
          case "discarding":
            throw new UserError(`workspace '${current.name}' discard is incomplete; retry workspace discard`);
          default:
            return assertNeverRecoveryPhase(current.phase);
        }
      }
      if (input.operation === "start" && current.phase !== "stopped") {
        throw new UserError(`workspace '${current.name}' is not a stopped native workspace`);
      }
      if (input.operation === "restart" && input.recovery !== true && current.phase !== "stopped") {
        input.setStage("workspace container readiness");
        await assertContainerRunning(input.runner, input.options.stateRoot, current);
        input.setStage("workspace stop");
        await stopWorkspaceLocked(input.runner, state, current);
        current = { ...current, phase: "stopped" };
      }
      current = applySelection(current, selected, current.profiles);
      input.setStage("workspace state publication");
      await state.writeWorkspace(current);
      const reconciled = await reconcileNativeWorkspace(
        input.runner, input.options, state, current, input.setStage
      );
      return setupWorkspaceLocked(input.runner, input.options, state, reconciled,
        false, true, input.setStage, input.setErrorStage);
    } finally {
      await runWorkspaceLifecycleStage(input.operation, "workspace setup lock release", releaseSetup);
    }
  } finally {
    await runWorkspaceLifecycleStage(input.operation, "Project lock release", releaseProject);
  }
}

function assertNeverRecoveryPhase(phase: never): never {
  throw new UserError(`unsupported native workspace recovery phase: ${String(phase)}`);
}

async function readCurrent(
  state: LifecycleState,
  input: NativeTransitionInput
): Promise<NativeWorkspaceRecord> {
  input.setStage("workspace state loading");
  const current = requireNative(await readWorkspaceForOperation(
    state, input.initial.name, input.options.giteaConnection
  ));
  assertWorkspaceLifecycleActive(current);
  if (current.workspaceId !== input.initial.workspaceId || current.projectId !== input.initial.projectId
    || !isDeepStrictEqual(current.source, input.initial.source)) {
    throw new UserError(`workspace '${current.name}' native source changed during ${input.operation}`);
  }
  return current;
}

function requireNative(record: WorkspaceRecord): NativeWorkspaceRecord {
  if (record.schemaVersion !== 9) throw new UserError("native workspace identity changed");
  return record;
}

function applySelection(
  current: NativeWorkspaceRecord,
  selected: NativeWorkspaceRecord,
  profiles: string[]
): NativeWorkspaceRecord {
  return { ...current, rootRepositoryAlias: selected.rootRepositoryAlias,
    rootRef: selected.rootRef, rootCommit: selected.rootCommit, source: selected.source,
    profiles, updatedAt: new Date().toISOString() };
}
