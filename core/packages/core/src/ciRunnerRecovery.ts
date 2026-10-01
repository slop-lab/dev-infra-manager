import { startCiRunner, stopCiRunner } from "./ciRunner.js";
import { UserError } from "./errors.js";
import { LifecycleState } from "./lifecycleState.js";
import type { HostLifecycleRecord, LifecycleOptions } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";

type CiRunnerRecoveryRequest = {
  readonly target: HostLifecycleRecord["restartCiRunners"][number];
  readonly normalizeReady: boolean;
};

export async function recoverCiRunner(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  request: CiRunnerRecoveryRequest
): Promise<void> {
  const { target } = request;
  const current = await new LifecycleState(options.stateRoot).readCiRunner(target.project, target.name);
  switch (current.executor.phase) {
    case "ready":
      if (!request.normalizeReady) return;
      await stopCiRunner(runner, options, target.project, target.name);
      break;
    case "stopped":
      break;
    case "creating":
    case "error":
      await stopCiRunner(runner, options, target.project, target.name);
      break;
    default:
      return assertNeverPhase(current.executor.phase);
  }
  await startCiRunner(runner, options, target);
}

function assertNeverPhase(phase: never): never {
  throw new UserError(`unsupported CI runner phase: ${String(phase)}`);
}
