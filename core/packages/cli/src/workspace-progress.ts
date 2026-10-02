const workspaceLifecycleOperations = [
  "workspace.create",
  "workspace.setup",
  "workspace.update",
  "workspace.start",
  "workspace.restart"
] as const;

const workspaceLifecycleStages = [
  "input validation",
  "project readiness validation",
  "managed Git reconciliation",
  "protected root selection",
  "Project lock acquisition",
  "workspace setup lock acquisition",
  "protected root validation",
  "Project state loading",
  "workspace state loading",
  "workspace capability resolution",
  "runtime capability resolution",
  "managed Git address discovery",
  "workspace state claim",
  "profile validation",
  "workspace runtime reconciliation",
  "selected root recording",
  "workspace stop",
  "workspace reconciliation",
  "container inspection",
  "workspace metadata publication",
  "workspace container reconciliation",
  "workspace reconciliation lock release",
  "Project manifest publication",
  "workspace container readiness",
  "protected root publication",
  "workspace state publication",
  "setup-state publication",
  "Project setup",
  "setup-error publication",
  "ready-state publication",
  "workspace setup lock release",
  "Project lock release"
] as const;

const remainingLifecycleMilestones = ["Project setup", "ready-state publication"] as const;
const terminalLifecycleStages = [
  "setup-error publication",
  "ready-state publication",
  "workspace setup lock release",
  "Project lock release"
] as const;

export type WorkspaceProgressStatus = {
  readonly current: string;
  readonly remaining: readonly string[];
};

export function initialWorkspaceProgress(operation: string): WorkspaceProgressStatus | undefined {
  if (!includes(workspaceLifecycleOperations, operation)) return undefined;
  return { current: "input validation", remaining: remainingLifecycleMilestones };
}

export function workspaceProgressStage(
  operation: string,
  stage: string
): WorkspaceProgressStatus | undefined {
  if (!includes(workspaceLifecycleOperations, operation) || !includes(workspaceLifecycleStages, stage)) {
    return undefined;
  }
  if (includes(terminalLifecycleStages, stage) || stage === "ready-state publication") {
    return { current: stage, remaining: [] };
  }
  if (stage === "Project setup") {
    return { current: stage, remaining: ["ready-state publication"] };
  }
  return { current: stage, remaining: remainingLifecycleMilestones };
}

function includes(values: readonly string[], candidate: string): boolean {
  return values.some((value) => value === candidate);
}
