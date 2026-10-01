import { UserError } from "./errors.js";

export type WorkspaceLifecycleOperation = "create" | "setup" | "update" | "start" | "restart";
export type SetWorkspaceLifecycleStage = (stage: string) => void;

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
  action: (setStage: SetWorkspaceLifecycleStage) => Promise<T>
): Promise<T> {
  let stage = "input validation";
  try {
    return await action((nextStage) => { stage = nextStage; });
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
  return runWorkspaceLifecycle(operation, async (setStage) => {
    setStage(stage);
    return action();
  });
}
