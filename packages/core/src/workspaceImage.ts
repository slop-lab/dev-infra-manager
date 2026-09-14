import { UserError } from "./errors.js";
import type { LifecycleOptions, WorkspaceRuntimeBackendKind } from "./lifecycleTypes.js";
import { workspaceRuntimePlan } from "./runtimeBackends.js";
import type { CommandRunner } from "./types.js";

export type WorkspaceImageReady = {
  readonly status: "ready";
  readonly imageId: string;
};

export type WorkspaceImageMissing = {
  readonly status: "missing";
};

export type WorkspaceImageStatus = WorkspaceImageReady | WorkspaceImageMissing;

export async function inspectWorkspaceImage(
  runner: CommandRunner,
  backend: WorkspaceRuntimeBackendKind,
  options: LifecycleOptions
): Promise<WorkspaceImageStatus> {
  const image = workspaceRuntimePlan(backend, options).image;
  const result = await runner.run("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
  if (result.exitCode === 0) {
    const imageId = result.stdout.trim();
    if (imageId.length === 0) {
      throw new UserError(`failed to inspect workspace image '${image}': Docker returned no image ID`);
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
      throw new UserError(
        `failed to inspect workspace image '${image}': Docker returned invalid image ID; expected ^sha256:[0-9a-f]{64}$, got '${imageId}'`
      );
    }
    return { status: "ready", imageId };
  }
  if (
    result.exitCode === 1
    && result.stdout.trim().length === 0
    && /^Error response from daemon: No such image: \S+$/.test(result.stderr.trim())
  ) {
    return { status: "missing" };
  }
  throw new UserError(
    `failed to inspect workspace image '${image}': ${(result.stderr || result.stdout).trim()}`
  );
}
