import type { ControlPlaneConfig } from "./controlPlaneConfig.js";
import { inspectControlPlaneDocker } from "./controlPlaneDockerInspect.js";
import type { ControlPlaneDockerRunner } from "./controlPlaneDockerTypes.js";
import {
  ControlPlaneInstallError,
  controlPlaneRollbackFailure
} from "./controlPlaneInstallError.js";
import {
  waitForControlPlaneServiceReady,
  type ControlPlaneReadinessPolicy,
  type ControlPlaneReadinessTarget
} from "./controlPlaneReadiness.js";
import {
  assertControlPlaneRuntimeTopology,
  assertControlPlaneServiceRuntimeTopology
} from "./controlPlaneRuntimeTopology.js";
import {
  assertFirstControlPlaneResources,
  cleanupFailedFirstControlPlane,
  createControlPlaneComposeFile,
  establishFirstControlPlaneResources,
  startFirstControlPlaneService,
  validateControlPlaneCompose
} from "./controlPlaneServiceRuntime.js";
import { replaceOwnedControlPlaneService } from "./controlPlaneServiceUpdate.js";
import {
  completeControlPlaneInstalledRollback,
  recordFailedFirstControlPlaneInstall,
  restorePriorControlPlaneInstalledState,
  type ControlPlaneCandidateGeneration,
  type ControlPlaneInstalledState
} from "./controlPlaneState.js";

export async function validateControlPlaneNoOp(input: {
  readonly runner: ControlPlaneDockerRunner;
  readonly config: ControlPlaneConfig;
  readonly prior: ControlPlaneInstalledState;
  readonly readinessPolicy?: ControlPlaneReadinessPolicy;
}): Promise<void> {
  const compose = await createControlPlaneComposeFile(input.prior.composeBytes);
  try {
    await validateControlPlaneCompose(input.runner, compose.path);
    await assertControlPlaneRuntimeTopology(input.runner, input.prior);
    await readyBoth(input.runner, {
      config: input.config,
      generationPath: input.prior.generationPath,
      generationId: input.prior.record.generationId,
      images: { nativeGit: input.prior.record.nativeGitImage, ordinaryCi: input.prior.record.ordinaryCiImage }
    }, input.readinessPolicy);
  } finally {
    await compose.close();
  }
}

export async function runFirstControlPlaneInstall(input: {
  readonly runner: ControlPlaneDockerRunner;
  readonly candidate: ControlPlaneCandidateGeneration;
  readonly composePath: string;
  readonly readinessPolicy?: ControlPlaneReadinessPolicy;
}): Promise<void> {
  await establishFirstControlPlaneResources(input.runner, input.candidate.config.deploymentId);
  await startFirstControlPlaneService({ ...input, deploymentId: input.candidate.config.deploymentId, service: "ordinary-ci" });
  await assertControlPlaneServiceRuntimeTopology(input.runner, {
    config: input.candidate.config, generationPath: input.candidate.generationPath,
    generationId: input.candidate.generationId, service: "ordinary-ci"
  });
  await ready(input.runner, input.candidate, "ordinary-ci", input.readinessPolicy);
  await startFirstControlPlaneService({ ...input, deploymentId: input.candidate.config.deploymentId, service: "native-git" });
  await assertControlPlaneServiceRuntimeTopology(input.runner, {
    config: input.candidate.config, generationPath: input.candidate.generationPath,
    generationId: input.candidate.generationId, service: "native-git"
  });
  await assertFirstControlPlaneResources(input.runner, input.candidate.config.deploymentId);
  await ready(input.runner, input.candidate, "native-git", input.readinessPolicy);
}

export async function runControlPlaneUpdate(input: {
  readonly runner: ControlPlaneDockerRunner;
  readonly candidate: ControlPlaneCandidateGeneration;
  readonly composePath: string;
  readonly readinessPolicy?: ControlPlaneReadinessPolicy;
}): Promise<void> {
  await replace(input, "ordinary-ci");
  await ready(input.runner, input.candidate, "ordinary-ci", input.readinessPolicy);
  await replace(input, "native-git");
  await ready(input.runner, input.candidate, "native-git", input.readinessPolicy);
}

export async function activateControlPlaneCandidate(
  runner: ControlPlaneDockerRunner,
  candidate: ControlPlaneCandidateGeneration
): Promise<void> {
  await activateControlPlaneTarget(runner, {
    config: candidate.config,
    generationPath: candidate.generationPath,
    generationId: candidate.generationId
  });
}

export async function rollbackControlPlaneUpdate(input: {
  readonly lock: Parameters<typeof restorePriorControlPlaneInstalledState>[0];
  readonly runner: ControlPlaneDockerRunner;
  readonly candidate: ControlPlaneCandidateGeneration;
  readonly prior: ControlPlaneInstalledState;
  readonly error: unknown;
  readonly readinessPolicy?: ControlPlaneReadinessPolicy;
}): Promise<never> {
  try {
    const compose = await createControlPlaneComposeFile(input.prior.composeBytes);
    try {
      const replacement = {
        runner: input.runner,
        composePath: compose.path,
        candidate: input.candidate,
        target: {
          config: priorConfig(input.candidate.config, input.prior),
          generationPath: input.prior.generationPath,
          generationId: input.prior.record.generationId,
          images: {
            nativeGit: input.prior.record.nativeGitImage,
            ordinaryCi: input.prior.record.ordinaryCiImage
          }
        }
      };
      await replace(replacement, "ordinary-ci");
       await ready(input.runner, replacement.target, "ordinary-ci", input.readinessPolicy);
      await replace(replacement, "native-git");
       await ready(input.runner, replacement.target, "native-git", input.readinessPolicy);
      await restorePriorControlPlaneInstalledState(input.lock, input.candidate, input.prior);
      await activateControlPlaneTarget(input.runner, {
        config: priorConfig(input.candidate.config, input.prior),
        generationPath: input.prior.generationPath,
        generationId: input.prior.record.generationId
      });
      await completeControlPlaneInstalledRollback(input.lock, input.candidate);
    } finally {
      await compose.close();
    }
  } catch (rollbackError) {
    throw controlPlaneRollbackFailure({
      original: input.error,
      rollback: rollbackError,
      priorGeneration: input.prior.record.generationId,
      candidateGeneration: input.candidate.generationId
    });
  }
  throw new ControlPlaneInstallError("control-plane update failed and the exact prior generation was restored", {
    cause: input.error
  });
}

export async function failFirstControlPlaneInstall(input: {
  readonly lock: Parameters<typeof recordFailedFirstControlPlaneInstall>[0];
  readonly runner: ControlPlaneDockerRunner;
  readonly candidate: ControlPlaneCandidateGeneration;
  readonly error: unknown;
}): Promise<never> {
  const recoveryErrors: unknown[] = [];
  try { await cleanupFailedFirstControlPlane({ runner: input.runner, deploymentId: input.candidate.config.deploymentId }); }
  catch (error) { recoveryErrors.push(error); }
  try { await recordFailedFirstControlPlaneInstall(input.lock, input.candidate); }
  catch (error) { recoveryErrors.push(error); }
  const cause = recoveryErrors.length === 0 ? input.error : new AggregateError([input.error, ...recoveryErrors]);
  throw new ControlPlaneInstallError(
    "first control-plane installation failed; exact-owned containers and network were cleanup candidates, data volumes and generation evidence were retained",
    { cause }
  );
}

export function activationTokenBytes(allocate: (size: number) => Buffer): Buffer {
  return Buffer.from(`${allocate(32).toString("base64url")}\n`);
}

async function replace(input: {
  readonly runner: ControlPlaneDockerRunner;
  readonly composePath: string;
  readonly candidate: ControlPlaneCandidateGeneration;
  readonly target?: {
    readonly config: ControlPlaneConfig;
    readonly generationPath: string;
    readonly generationId: string;
    readonly images?: { readonly nativeGit: string; readonly ordinaryCi: string };
  };
}, service: "native-git" | "ordinary-ci"): Promise<void> {
  await replaceOwnedControlPlaneService({
    runner: input.runner, composePath: input.composePath,
    deploymentId: input.candidate.config.deploymentId, service,
    target: input.target ?? {
      config: input.candidate.config,
      generationPath: input.candidate.generationPath,
      generationId: input.candidate.generationId
    }
  });
}

type ActivationTarget = {
  readonly config: ControlPlaneConfig;
  readonly generationPath: string;
  readonly generationId: string;
};

export async function activateControlPlaneTarget(runner: ControlPlaneDockerRunner, target: ActivationTarget): Promise<void> {
  await activateService(runner, target, "ordinary-ci", "10002:10002");
  await activateService(runner, target, "native-git", "10001:10001");
}

async function activateService(
  runner: ControlPlaneDockerRunner,
  target: ActivationTarget,
  service: "native-git" | "ordinary-ci",
  user: "10001:10001" | "10002:10002"
): Promise<void> {
  const state = await inspectControlPlaneDocker(runner, target.config.deploymentId);
  if (state.kind !== "owned") throw new ControlPlaneInstallError("control-plane activation requires complete owned resources");
  const containerId = service === "native-git" ? state.nativeGitContainerId : state.ordinaryCiContainerId;
  await assertControlPlaneServiceRuntimeTopology(runner, { ...target, service, containerId });
  const result = await runner.run({
    args: [
      "container", "exec", "--user", user, containerId,
      "/usr/local/bin/dim-service", "activate", target.generationId
    ],
    timeoutMilliseconds: 10_000,
    maximumOutputBytes: 4 * 1024
  });
  if (result.exitCode !== 0 || result.stdout !== "" || result.stderr !== "") {
    throw new ControlPlaneInstallError(`control-plane ${service} activation failed`);
  }
}

async function readyBoth(
  runner: ControlPlaneDockerRunner,
  target: ControlPlaneReadinessTarget,
  policy?: ControlPlaneReadinessPolicy
): Promise<void> {
  await ready(runner, target, "ordinary-ci", policy);
  await ready(runner, target, "native-git", policy);
}

function priorConfig(config: ControlPlaneConfig, prior: ControlPlaneInstalledState): ControlPlaneConfig {
  return {
    ...config,
    nativeGit: { ...config.nativeGit, image: prior.record.nativeGitImage, publish: prior.record.nativeGitPublish },
    ordinaryCi: { ...config.ordinaryCi, image: prior.record.ordinaryCiImage, publish: prior.record.ordinaryCiPublish }
  };
}

async function ready(
  runner: ControlPlaneDockerRunner,
  target: ControlPlaneReadinessTarget,
  service: "native-git" | "ordinary-ci",
  policy?: ControlPlaneReadinessPolicy
): Promise<void> {
  await waitForControlPlaneServiceReady({ runner, target, service, ...(policy === undefined ? {} : { policy }) });
}
