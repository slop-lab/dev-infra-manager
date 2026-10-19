import { inspectControlPlaneDocker } from "./controlPlaneDockerInspect.js";
import type { ControlPlaneDockerRunner } from "./controlPlaneDockerTypes.js";
import { assertControlPlaneServiceRuntimeTopology } from "./controlPlaneRuntimeTopology.js";
import type { ControlPlaneConfig } from "./controlPlaneConfig.js";

const project = "dim-control-plane";
const outputLimit = 64 * 1024;
const commandTimeout = 60_000;

export async function replaceOwnedControlPlaneService(input: {
  readonly runner: ControlPlaneDockerRunner;
  readonly composePath: string;
  readonly deploymentId: string;
  readonly service: "native-git" | "ordinary-ci";
  readonly target: {
    readonly config: ControlPlaneConfig;
    readonly generationPath: string;
    readonly generationId: string;
    readonly images?: { readonly nativeGit: string; readonly ordinaryCi: string };
  };
}): Promise<void> {
  const state = await inspectControlPlaneDocker(input.runner, input.deploymentId);
  if (state.kind !== "owned") throw new ControlPlaneServiceUpdateError("control-plane replacement requires complete owned resources");
  const result = await input.runner.run({
    args: [
      "compose", "--project-name", project, "--file", input.composePath,
      "up", "--detach", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", input.service
    ],
    timeoutMilliseconds: commandTimeout,
    maximumOutputBytes: outputLimit
  });
  if (result.exitCode !== 0) throw new ControlPlaneServiceUpdateError(`control-plane ${input.service} replacement failed`);
  const after = await inspectControlPlaneDocker(input.runner, input.deploymentId);
  if (after.kind !== "owned") throw new ControlPlaneServiceUpdateError(`control-plane ${input.service} replacement is incomplete`);
  await assertControlPlaneServiceRuntimeTopology(input.runner, { ...input.target, service: input.service });
}

export class ControlPlaneServiceUpdateError extends Error {
  readonly name = "ControlPlaneServiceUpdateError";
}
