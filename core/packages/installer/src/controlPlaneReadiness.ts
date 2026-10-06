import { inspectControlPlaneServiceContainer } from "./controlPlaneDockerInspect.js";
import {
  ControlPlaneDockerExecutionError,
  ControlPlaneDockerUncertainError,
  type ControlPlaneDockerCommand,
  type ControlPlaneDockerCommandResult,
  type ControlPlaneDockerRunner
} from "./controlPlaneDockerTypes.js";
import { ControlPlaneInstallError } from "./controlPlaneInstallError.js";
import { assertControlPlaneServiceRuntimeTopology } from "./controlPlaneRuntimeTopology.js";
import type { ControlPlaneConfig } from "./controlPlaneConfig.js";

const defaultReadinessPolicy = {
  timeoutMilliseconds: 60_000,
  retryIntervalMilliseconds: 250,
  execTimeoutMilliseconds: 3_000
} as const;

export type ControlPlaneReadinessPolicy = {
  readonly timeoutMilliseconds: number;
  readonly retryIntervalMilliseconds: number;
  readonly execTimeoutMilliseconds: number;
};

export type ControlPlaneReadinessTarget = {
  readonly config: ControlPlaneConfig;
  readonly generationPath: string;
  readonly generationId: string;
  readonly images?: { readonly nativeGit: string; readonly ordinaryCi: string };
};

export async function waitForControlPlaneServiceReady(input: {
  readonly runner: ControlPlaneDockerRunner;
  readonly target: ControlPlaneReadinessTarget;
  readonly service: "native-git" | "ordinary-ci";
  readonly policy?: ControlPlaneReadinessPolicy;
}): Promise<void> {
  const policy = input.policy ?? defaultReadinessPolicy;
  if (policy.timeoutMilliseconds < 1 || policy.timeoutMilliseconds > 60_000
    || policy.retryIntervalMilliseconds < 1 || policy.execTimeoutMilliseconds < 1) {
    throw new ControlPlaneInstallError("control-plane readiness policy is invalid");
  }
  const deadline = performance.now() + policy.timeoutMilliseconds;
  while (performance.now() < deadline) {
    const runner = deadlineRunner(input.runner, deadline);
    try {
      const containerId = await inspectControlPlaneServiceContainer(
        runner, input.target.config.deploymentId, input.service
      );
      await assertControlPlaneServiceRuntimeTopology(runner, { ...input.target, service: input.service, containerId });
      const result = await runner.run({
        args: [
          "container", "exec", "--user", input.service === "native-git" ? "10001:10001" : "10002:10002",
          containerId, "/usr/local/bin/dim-service", "ready"
        ],
        timeoutMilliseconds: policy.execTimeoutMilliseconds,
        maximumOutputBytes: 4 * 1024
      });
      if (result.exitCode === 0 && result.stdout === "" && result.stderr === "") return;
    } catch (error) {
      if (error instanceof ControlPlaneDockerUncertainError) throw error;
      if (!(error instanceof ControlPlaneDockerExecutionError)) throw error;
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) await delay(Math.min(remaining, policy.retryIntervalMilliseconds));
  }
  throw new ControlPlaneInstallError(`control-plane ${input.service} did not become ready before its deadline`, {
    code: "readiness-failed"
  });
}

function deadlineRunner(runner: ControlPlaneDockerRunner, deadline: number): ControlPlaneDockerRunner {
  return {
    async run(command: ControlPlaneDockerCommand): Promise<ControlPlaneDockerCommandResult> {
      const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
      return await runner.run({ ...command, timeoutMilliseconds: Math.min(command.timeoutMilliseconds, remaining) });
    }
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
