import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readControlPlaneConfig } from "./controlPlaneConfig.js";
import { inspectControlPlaneDocker } from "./controlPlaneDockerInspect.js";
import { assertControlPlaneProbeSnapshots, probeControlPlaneImages } from "./controlPlaneImageProbe.js";
import { ProcessControlPlaneDockerRunner } from "./controlPlaneDockerRunner.js";
import {
  ControlPlaneDockerUncertainError,
  type ControlPlaneDockerRunner,
  type ControlPlaneDockerState
} from "./controlPlaneDockerTypes.js";
import { ControlPlaneInstallError } from "./controlPlaneInstallError.js";
import type { ControlPlaneReadinessPolicy } from "./controlPlaneReadiness.js";
import { assertControlPlaneRuntimeTopology } from "./controlPlaneRuntimeTopology.js";
import {
  activateControlPlaneCandidate,
  activationTokenBytes,
  failFirstControlPlaneInstall,
  rollbackControlPlaneUpdate,
  runControlPlaneUpdate,
  runFirstControlPlaneInstall,
  validateControlPlaneNoOp
} from "./controlPlaneInstallTransaction.js";
import { discardControlPlanePreflight } from "./controlPlanePreflightFailure.js";
import { acquireControlPlaneStateLock } from "./controlPlaneLock.js";
import { probeControlPlanePublishedAddresses } from "./controlPlanePortProbe.js";
import { preflightControlPlanePredecessor } from "./controlPlanePredecessor.js";
import { createControlPlaneComposeFile, validateControlPlaneCompose } from "./controlPlaneServiceRuntime.js";
import { completeControlPlaneSourcePreflight, readControlPlaneSources } from "./controlPlaneSources.js";
import {
  assertControlPlaneStagedSources,
  completeControlPlaneInstalledState,
  finalizeControlPlaneGeneration,
  isControlPlaneInstalledInput,
  publishControlPlaneInstalledState,
  readControlPlaneInstalledState,
  stageControlPlaneSources,
  type ControlPlaneInstalledState
} from "./controlPlaneState.js";
import { probeControlPlaneUpdate } from "./controlPlaneUpdateProbe.js";

export type ControlPlaneInstallOptions = {
  readonly configPath: string;
  readonly stateRoot: string;
  readonly runner?: ControlPlaneDockerRunner;
  readonly readinessPolicy?: ControlPlaneReadinessPolicy;
  readonly randomBytes?: (size: number) => Buffer;
  readonly environment?: NodeJS.ProcessEnv;
};

export type FirstControlPlaneInstallOptions = ControlPlaneInstallOptions;

export async function installControlPlane(options: ControlPlaneInstallOptions): Promise<ControlPlaneInstalledState> {
  return await install(options, false);
}

export async function installFirstControlPlane(options: FirstControlPlaneInstallOptions): Promise<ControlPlaneInstalledState> {
  return await install(options, true);
}

async function install(options: ControlPlaneInstallOptions, firstOnly: boolean): Promise<ControlPlaneInstalledState> {
  await preflightControlPlanePredecessor(options.environment ?? process.env);
  const config = await readControlPlaneConfig(options.configPath);
  const sources = await readControlPlaneSources(config);
  const runner = options.runner ?? new ProcessControlPlaneDockerRunner();
  const allocate = options.randomBytes ?? randomBytes;
  const lock = await acquireControlPlaneStateLock(options.stateRoot);
  try {
    const prior = await readControlPlaneInstalledState(lock);
    if (firstOnly && prior !== undefined) throw new ControlPlaneInstallError("first control-plane installation requires absent installed state");
    if (prior !== undefined && prior.record.deploymentId !== config.deploymentId) {
      throw new ControlPlaneInstallError("changing the control-plane deployment ID in place is unsupported");
    }
    if (prior !== undefined && isControlPlaneInstalledInput(prior, config, sources)) {
      const docker = await inspectControlPlaneDocker(runner, config.deploymentId, prior.record.volumesEstablished);
      assertResourceState(prior, docker);
      await validateControlPlaneNoOp({
        runner, config, prior, ...(options.readinessPolicy === undefined ? {} : { readinessPolicy: options.readinessPolicy })
      });
      return prior;
    }
    const staging = await stageControlPlaneSources({ lock, sources, prior });
    let docker: ControlPlaneDockerState;
    try {
      await assertControlPlaneStagedSources({ lock, staging, sources });
      const snapshots = { nativeGit: join(staging.path, "native-git.json"), ordinaryCi: join(staging.path, "ordinary-ci.json") };
      assertControlPlaneProbeSnapshots(config, snapshots);
      docker = await inspectControlPlaneDocker(runner, config.deploymentId, prior?.record.volumesEstablished);
      assertResourceState(prior, docker);
      if (prior !== undefined) await assertControlPlaneRuntimeTopology(runner, prior);
      await probeControlPlaneImages(runner, config, snapshots);
      if (prior !== undefined) {
        await probeControlPlaneUpdate(runner, {
          nativeGit: { candidate: config.nativeGit.image, prior: prior.record.nativeGitImage },
          ordinaryCi: { candidate: config.ordinaryCi.image, prior: prior.record.ordinaryCiImage }
        });
      }
      await probeControlPlanePublishedAddresses(runner, config, prior === undefined ? undefined : {
        nativeGit: prior.record.nativeGitPublish,
        ordinaryCi: prior.record.ordinaryCiPublish
      });
    } catch (error) {
      await discardControlPlanePreflight(lock, staging, error);
    }

    const completed = completeControlPlaneSourcePreflight(sources, {
      nativeGit: activationTokenBytes(allocate), ordinaryCi: activationTokenBytes(allocate)
    });
    const candidate = await finalizeControlPlaneGeneration({ lock, staging, config, sources: completed });
    const compose = await createControlPlaneComposeFile(candidate.composeBytes);
    let updateMutationStarted = false;
    try {
      await validateControlPlaneCompose(runner, compose.path);
      if (prior === undefined) {
        await runFirstControlPlaneInstall({
          runner, candidate, composePath: compose.path,
          ...(options.readinessPolicy === undefined ? {} : { readinessPolicy: options.readinessPolicy })
        });
      } else {
        updateMutationStarted = true;
        await runControlPlaneUpdate({
          runner, candidate, composePath: compose.path,
          ...(options.readinessPolicy === undefined ? {} : { readinessPolicy: options.readinessPolicy })
        });
      }
      await publishControlPlaneInstalledState(lock, candidate, { volumesEstablished: true });
      await activateControlPlaneCandidate(runner, candidate);
      await completeControlPlaneInstalledState(lock, candidate);
    } catch (error) {
      if (error instanceof ControlPlaneDockerUncertainError) throw error;
      if (prior === undefined) return await failFirstControlPlaneInstall({ lock, runner, candidate, error });
      if (!updateMutationStarted) {
        throw new ControlPlaneInstallError("control-plane update failed before resource mutation; candidate evidence was retained", { cause: error });
      }
       await rollbackControlPlaneUpdate({
         lock, runner, candidate, prior, error,
         ...(options.readinessPolicy === undefined ? {} : { readinessPolicy: options.readinessPolicy })
       });
    } finally {
      await compose.close();
    }
    const result = await readControlPlaneInstalledState(lock);
    if (result === undefined) throw new ControlPlaneInstallError("completed control-plane installation has no installed record");
    return result;
  } finally {
    await lock.close();
  }
}

function assertResourceState(prior: ControlPlaneInstalledState | undefined, docker: ControlPlaneDockerState): void {
  if (prior === undefined && docker.kind !== "absent") {
    throw new ControlPlaneInstallError("first control-plane installation requires absent Docker resources");
  }
  if (prior !== undefined && docker.kind !== "owned") {
    throw new ControlPlaneInstallError("control-plane update requires complete owned Docker resources");
  }
}

export { ControlPlaneInstallError };
