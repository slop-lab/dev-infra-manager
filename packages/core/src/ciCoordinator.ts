import type { CommandRunner } from "./types.js";
import type { LifecycleOptions, ProjectRecord } from "./lifecycleTypes.js";

export interface CiRunnerRegistration {
  provider: string;
  instanceUrl: string;
  token: string;
}

export type QueuedWorkflowJob = {
  readonly id: number;
  readonly labels: readonly string[];
};

export type WorkflowJobWebhookInput = {
  readonly url: string;
  readonly authorizationHeader: string;
  readonly replayQueuedJob: (job: QueuedWorkflowJob) => Promise<void>;
};

export interface CiCoordinator {
  prepareRunner(
    runner: CommandRunner,
    options: LifecycleOptions,
    project: ProjectRecord
  ): Promise<CiRunnerRegistration>;
  removeRunner(
    runner: CommandRunner,
    options: LifecycleOptions,
    project: ProjectRecord,
    runnerName: string
  ): Promise<void>;
  ensureWorkflowJobWebhook(
    runner: CommandRunner,
    options: LifecycleOptions,
    project: ProjectRecord,
    input: WorkflowJobWebhookInput
  ): Promise<void>;
  removeWorkflowJobWebhook(
    runner: CommandRunner,
    options: LifecycleOptions,
    project: ProjectRecord,
    url: string
  ): Promise<void>;
  reconcileWorkflowJobWebhookTargets(
    runner: CommandRunner,
    options: LifecycleOptions,
    excluding?: { readonly project: string; readonly name: string }
  ): Promise<void>;
}
