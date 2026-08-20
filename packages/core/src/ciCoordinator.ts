import type { CommandRunner } from "./types.js";
import type { LifecycleOptions, ProjectRecord } from "./lifecycleTypes.js";

export interface CiRunnerRegistration {
  provider: string;
  instanceUrl: string;
  token: string;
}

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
    input: { name: string; url: string; authorizationHeader: string }
  ): Promise<void>;
  removeWorkflowJobWebhook(
    runner: CommandRunner,
    options: LifecycleOptions,
    project: ProjectRecord,
    name: string
  ): Promise<void>;
}
