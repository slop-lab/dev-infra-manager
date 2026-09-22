import type { QueuedWorkflowJob } from "./ciCoordinator.js";
import { inspectCiRunnerContainer, ciRunnerContainerPlan } from "./ciRunnerContainer.js";
import { UserError } from "./errors.js";
import type { CiRunnerRecord, QemuCiRunnerExecutor } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";

type QemuBacklogReplayPlan = {
  readonly runner: StreamingCommandRunner;
  readonly record: Pick<CiRunnerRecord, "projectName" | "projectId" | "name">;
  readonly executor: QemuCiRunnerExecutor;
  readonly authorization: string;
};

export async function prepareQemuBacklogReplay(
  plan: QemuBacklogReplayPlan
): Promise<(job: QueuedWorkflowJob) => Promise<void>> {
  const containerId = await inspectCiRunnerContainer(plan.runner, ciRunnerContainerPlan(plan.record, plan.executor));
  if (containerId === undefined) throw new UserError(`QEMU CI supervisor '${plan.executor.supervisorName}' disappeared after launch`);
  const health = await plan.runner.run("docker", [
    "exec", containerId,
    "curl", "--fail", "--silent", "--show-error",
    "--retry", "89", "--retry-delay", "1", "--retry-connrefused", "--retry-max-time", "90",
    "--connect-timeout", "1", "--max-time", "2",
    "--header", `Authorization: ${plan.authorization}`,
    "http://127.0.0.1:8080/healthz"
  ]);
  if (health.exitCode !== 0) {
    throw new UserError(`QEMU CI supervisor '${plan.executor.supervisorName}' did not become ready: ${health.stderr.trim()}`);
  }
  return async (job) => {
    const payload = JSON.stringify({ action: "queued", workflow_job: job });
    const replayed = await plan.runner.run("docker", [
      "exec", containerId,
      "curl", "--fail", "--silent", "--show-error",
      "--connect-timeout", "1", "--max-time", "10",
      "--request", "POST",
      "--header", `Authorization: ${plan.authorization}`,
      "--header", "Content-Type: application/json",
      "--header", "X-Gitea-Event: workflow_job",
      "--data-binary", payload,
      "http://127.0.0.1:8080/workflow-job"
    ]);
    if (replayed.exitCode !== 0) {
      throw new UserError(`failed to replay queued workflow job ${job.id}: ${replayed.stderr.trim()}`);
    }
  };
}
