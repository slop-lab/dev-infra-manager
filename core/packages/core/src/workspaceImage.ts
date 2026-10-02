import { cp, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "./errors.js";
import type { LifecycleOptions, WorkspaceRuntimeBackendKind } from "./lifecycleTypes.js";
import { workspaceRuntimePlan } from "./runtimeBackends.js";
import type { CommandRunner, LongOperationOptions } from "./types.js";
import { workspaceImageReference } from "./workspaceImageReference.js";

export type WorkspaceImageReady = {
  readonly status: "ready";
  readonly imageId: string;
};

export type WorkspaceImageMissing = {
  readonly status: "missing";
};

export type WorkspaceImageStatus = WorkspaceImageReady | WorkspaceImageMissing;

export type WorkspaceImageBuild = {
  readonly image: string;
};

export async function buildWorkspaceImage(
  runner: CommandRunner,
  env: NodeJS.ProcessEnv = process.env,
  operation: LongOperationOptions = {}
): Promise<WorkspaceImageBuild> {
  const image = workspaceImageReference(env.DIM_WORKSPACE_IMAGE);
  assertBuildDestination(image);
  if (process.getuid === undefined || process.getgid === undefined) {
    throw new UserError("workspace image builds require a Linux user identity");
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), "dim-workspace-image-"));
  const context = join(temporaryRoot, "context");
  try {
    const assets = fileURLToPath(new URL("./workspace-image-assets", import.meta.url));
    const controllerProxy = dirname(createRequire(import.meta.url).resolve("@slop-lab/dim-controller-proxy"));
    await cp(assets, context, { recursive: true });
    await cp(controllerProxy, join(context, "controller-proxy"), { recursive: true });
    operation.reportProgress?.("Docker image build");
    const result = await runner.run("docker", [
      "buildx", "build", "--load",
      "--build-arg", `DIM_UID=${process.getuid()}`,
      "--build-arg", `DIM_GID=${process.getgid()}`,
      "--tag", image,
      "--file", "Dockerfile", "."
    ], {
      cwd: context,
      ...(operation.signal === undefined ? {} : { signal: operation.signal })
    });
    if (result.exitCode !== 0) {
      throw new UserError(
        `failed to build workspace image '${image}': ${(result.stderr || result.stdout).trim()}`
      );
    }
    return { image };
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(
      `failed to prepare workspace image build context: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

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

function assertBuildDestination(image: string): void {
  if (image.startsWith("sha256:") || image.includes("@")) {
    throw new UserError(`cannot build an immutable workspace image destination '${image}'; use an explicit tag`);
  }
  const tagSeparator = image.lastIndexOf(":");
  if (tagSeparator <= image.lastIndexOf("/") || tagSeparator === image.length - 1) {
    throw new UserError(`workspace image build destination '${image}' must include an explicit tag`);
  }
  if (image.slice(tagSeparator + 1) === "latest") {
    throw new UserError("workspace image build destination must not use the mutable 'latest' tag");
  }
}
