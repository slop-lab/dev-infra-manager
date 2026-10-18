import { UserError } from "@slop-lab/dim-core";
import type { WorkspaceRecord } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "@slop-lab/dim-core";
import { inspectWorkspaceAgentContainer } from "./workspaceAgentInspection.js";
import {
  allocateWorkspaceResourceBudget,
  updateContainerResourceLimits,
  type WorkspaceResourceLimits
} from "./workspaceResourceBudget.js";

export async function reconcileRecommendedWorkspaceResourceBudget(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  outerContainerId: string
): Promise<void> {
  const allocation = allocateWorkspaceResourceBudget("recommended", record);
  const agent = await inspectWorkspaceAgentContainer(runner, record);
  if (agent === undefined) throw new UserError(`recommended agent for workspace '${record.name}' is unavailable`);
  await updateContainerResourceLimits({
    runner,
    containerId: outerContainerId,
    limits: allocation.outer,
    action: "reconcile recommended workspace outer resources"
  });
  try {
    await updateContainerResourceLimits({
      runner,
      containerId: agent.id,
      limits: allocation.agent,
      action: "reconcile recommended workspace agent resources"
    });
  } catch (error) {
    if (agent.running) {
      const stopped = await runner.run("docker", ["stop", agent.id]);
      if (stopped.exitCode !== 0) {
        throw new UserError(
          `recommended workspace resource state is uncertain: failed to stop agent after allocation failure: ${stopped.stderr.trim()}`
        );
      }
    }
    throw error;
  }
}

export async function updateWorkspaceAgentResources(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  resources: WorkspaceResourceLimits
): Promise<void> {
  const container = await inspectWorkspaceAgentContainer(runner, record);
  if (container === undefined) throw new UserError(`recommended agent for workspace '${record.name}' is unavailable`);
  await updateContainerResourceLimits({
    runner,
    containerId: container.id,
    limits: resources,
    action: "update recommended workspace agent resources"
  });
}

type WorkspaceResourceUpdate = {
  readonly runner: StreamingCommandRunner;
  readonly record: WorkspaceRecord;
  readonly outerContainerId: string;
  readonly resources: WorkspaceResourceLimits;
  readonly publish: () => Promise<void>;
  readonly restore: () => Promise<void>;
};

export async function applyWorkspaceResourceUpdate(update: WorkspaceResourceUpdate): Promise<void> {
  const environment = update.record.environment ?? "custom";
  const previousAllocation = allocateWorkspaceResourceBudget(environment, update.record);
  const nextAllocation = allocateWorkspaceResourceBudget(environment, update.resources);
  let outerAttempted = false;
  let agentAttempted = false;
  let publicationAttempted = false;
  try {
    outerAttempted = true;
    await updateContainerResourceLimits({
      runner: update.runner,
      containerId: update.outerContainerId,
      limits: nextAllocation.outer,
      action: "update workspace resources"
    });
    if (nextAllocation.agent !== undefined) {
      agentAttempted = true;
      await updateWorkspaceAgentResources(update.runner, update.record, nextAllocation.agent);
    }
    publicationAttempted = true;
    await update.publish();
  } catch (error) {
    const rollbackErrors: Error[] = [];
    if (agentAttempted && previousAllocation.agent !== undefined) {
      await captureRollbackError(
        updateWorkspaceAgentResources(update.runner, update.record, previousAllocation.agent),
        rollbackErrors
      );
    }
    if (outerAttempted) {
      await captureRollbackError(updateContainerResourceLimits({
        runner: update.runner,
        containerId: update.outerContainerId,
        limits: previousAllocation.outer,
        action: "restore previous workspace resources"
      }), rollbackErrors);
    }
    if (publicationAttempted) await captureRollbackError(update.restore(), rollbackErrors);
    if (rollbackErrors.length !== 0) {
      throw new UserError(
        `workspace resource state is uncertain after update failure: ${rollbackErrors.map((failure) => failure.message).join("; ")}`
      );
    }
    throw error;
  }
}

async function captureRollbackError(operation: Promise<void>, failures: Error[]): Promise<void> {
  try {
    await operation;
  } catch (error) {
    failures.push(error instanceof Error ? error : new UserError(String(error)));
  }
}
