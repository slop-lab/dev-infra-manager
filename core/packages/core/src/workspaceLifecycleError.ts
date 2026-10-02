import { AsyncLocalStorage } from "node:async_hooks";
import { UserError } from "./errors.js";

export type WorkspaceLifecycleOperation = "create" | "setup" | "update" | "start" | "restart";
export type SetWorkspaceLifecycleStage = (stage: string) => void;
export type SetWorkspaceLifecycleErrorStage = (stage: string) => void;
export type ReportWorkspaceLifecycleProgress = (
  operation: WorkspaceLifecycleOperation,
  stage: string
) => void;

const lifecycleProgress = new AsyncLocalStorage<ReportWorkspaceLifecycleProgress>();

class WorkspaceLifecycleError extends UserError {
  readonly operation: WorkspaceLifecycleOperation;
  readonly stage: string;

  constructor(operation: WorkspaceLifecycleOperation, stage: string, cause: unknown) {
    super(
      `workspace ${operation} at ${stage}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.operation = operation;
    this.stage = stage;
  }
}

export async function runWorkspaceLifecycle<T>(
  operation: WorkspaceLifecycleOperation,
  action: (
    setStage: SetWorkspaceLifecycleStage,
    setErrorStage: SetWorkspaceLifecycleErrorStage
  ) => Promise<T>
): Promise<T> {
  return executeWorkspaceLifecycle(operation, "input validation", action);
}

export function withWorkspaceLifecycleProgress<T>(
  report: ReportWorkspaceLifecycleProgress,
  action: () => Promise<T>
): Promise<T> {
  return lifecycleProgress.run(report, action);
}

async function executeWorkspaceLifecycle<T>(
  operation: WorkspaceLifecycleOperation,
  initialStage: string,
  action: (
    setStage: SetWorkspaceLifecycleStage,
    setErrorStage: SetWorkspaceLifecycleErrorStage
  ) => Promise<T>
): Promise<T> {
  let stage = initialStage;
  const setStage = (nextStage: string): void => {
    stage = nextStage;
    lifecycleProgress.getStore()?.(operation, stage);
  };
  const setErrorStage = (nextStage: string): void => {
    stage = nextStage;
  };
  setStage(initialStage);
  try {
    return await action(setStage, setErrorStage);
  } catch (error) {
    if (error instanceof WorkspaceLifecycleError && error.operation === operation) throw error;
    throw new WorkspaceLifecycleError(operation, stage, error);
  }
}

export async function runWorkspaceLifecycleStage<T>(
  operation: WorkspaceLifecycleOperation,
  stage: string,
  action: () => Promise<T>
): Promise<T> {
  return executeWorkspaceLifecycle(operation, stage, async () => action());
}
