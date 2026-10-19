import { inspectControlPlaneDocker } from "./controlPlaneDockerInspect.js";
import { assertControlPlaneProbeSnapshots, probeControlPlaneImages } from "./controlPlaneImageProbe.js";
import type {
  ControlPlaneDockerPreflightInput,
  ControlPlaneDockerRunner,
  ControlPlaneDockerState
} from "./controlPlaneDockerTypes.js";

export {
  ControlPlaneDockerError,
  ControlPlaneDockerExecutionError,
  ControlPlaneDockerUncertainError,
  type ControlPlaneDockerCommand,
  type ControlPlaneDockerCommandResult,
  type ControlPlaneDockerPreflightInput,
  type ControlPlaneDockerRunner,
  type ControlPlaneDockerState,
  type ControlPlaneProbeSnapshots
} from "./controlPlaneDockerTypes.js";
export { ProcessControlPlaneDockerRunner } from "./controlPlaneDockerRunner.js";
export { inspectControlPlaneDocker } from "./controlPlaneDockerInspect.js";
export { assertControlPlaneProbeSnapshots, probeControlPlaneImages } from "./controlPlaneImageProbe.js";

export async function preflightControlPlaneDocker(
  runner: ControlPlaneDockerRunner,
  input: ControlPlaneDockerPreflightInput
): Promise<ControlPlaneDockerState> {
  assertControlPlaneProbeSnapshots(input.config, input.snapshots);
  const state = await inspectControlPlaneDocker(runner, input.config.deploymentId);
  await probeControlPlaneImages(runner, input.config, input.snapshots);
  return state;
}
