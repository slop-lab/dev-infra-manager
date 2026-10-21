import type { TaskAssignment } from "./tasks.js";

export const executionTaskHandlerKind = "dim.execution.task-handler";
export interface ExecutionTaskHandler {
  readonly taskType: string;
  readonly revision: string;
  run(input: {
    readonly assignment: TaskAssignment;
    readonly payload: unknown;
    readonly exchange: (operation: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  cleanup(input: { readonly assignment: TaskAssignment }): Promise<boolean>;
}
export function executionTaskHandlers(extensions: readonly { readonly kind: string; readonly name: string; readonly value: object }[]): readonly ExecutionTaskHandler[] {
  const handlers = extensions.filter(({ kind }) => kind === executionTaskHandlerKind).map(({ name, value }) => {
    const handler = value as ExecutionTaskHandler;
    if (handler.taskType !== name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(handler.taskType) || !/^[0-9a-f]{64}$/.test(handler.revision) || typeof handler.run !== "function" || typeof handler.cleanup !== "function") throw new Error("invalid execution task handler");
    return handler;
  });
  if (new Set(handlers.map(({ taskType }) => taskType)).size !== handlers.length) throw new Error("duplicate execution task handler");
  return handlers;
}
