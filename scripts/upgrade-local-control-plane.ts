import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { readControlPlaneConfig } from "../packages/installer/src/controlPlaneConfig.ts";
import { readControlPlaneSources, completeControlPlaneSourcePreflight } from "../packages/installer/src/controlPlaneSources.ts";
import { ProcessControlPlaneDockerRunner } from "../packages/installer/src/controlPlaneDockerRunner.ts";
import { inspectControlPlaneDocker } from "../packages/installer/src/controlPlaneDockerInspect.ts";
import { acquireControlPlaneStateLock } from "../packages/installer/src/controlPlaneLock.ts";
import { assertControlPlaneRuntimeTopology } from "../packages/installer/src/controlPlaneRuntimeTopology.ts";
import { probeControlPlaneImages } from "../packages/installer/src/controlPlaneImageProbe.ts";
import { probeControlPlanePublishedAddresses } from "../packages/installer/src/controlPlanePortProbe.ts";
import { createControlPlaneComposeFile, validateControlPlaneCompose } from "../packages/installer/src/controlPlaneServiceRuntime.ts";
import { activateControlPlaneCandidate, activationTokenBytes, rollbackControlPlaneUpdate, runControlPlaneUpdate } from "../packages/installer/src/controlPlaneInstallTransaction.ts";
import { readControlPlaneInstalledState, stageControlPlaneSources, assertControlPlaneStagedSources, finalizeControlPlaneGeneration,
  publishControlPlaneInstalledState, completeControlPlaneInstalledState, discardControlPlaneStaging } from "../packages/installer/src/controlPlaneState.ts";
import type { ControlPlaneCandidateGeneration } from "../packages/installer/src/controlPlaneState.ts";
import { checkpointVolumes, restoreVolumes, stopOwnedServices, forwardReadable, runDocker, captureServiceLogs, type VolumeCheckpoint } from "./local-control-plane/checkpoint.ts";

/** Developer-only downtime upgrade: checkpoints replace the production installer's reversible-format requirement. */
export async function upgradeLocalControlPlane(configPath: string, stateRoot: string, backupRoot: string): Promise<string> {
  const config = await readControlPlaneConfig(resolve(configPath));
  const sources = await readControlPlaneSources(config);
  const runner = new ProcessControlPlaneDockerRunner();
  const lock = await acquireControlPlaneStateLock(resolve(stateRoot));
  try {
    const prior = await readControlPlaneInstalledState(lock);
    if (!prior || prior.record.deploymentId !== config.deploymentId) throw new Error("local upgrade requires the exact existing deployment");
    const owned = await inspectControlPlaneDocker(runner, config.deploymentId, true);
    if (owned.kind !== "owned") throw new Error("local upgrade requires complete owned resources");
    await assertControlPlaneRuntimeTopology(runner, prior);
    const staging = await stageControlPlaneSources({ lock, sources, prior });
    const backupDirectory = resolve(backupRoot, `control-plane-upgrade-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`);
    let candidate: ControlPlaneCandidateGeneration | undefined;
    let stopped = false;
    let committed = false;
    let checkpoints: readonly VolumeCheckpoint[] | undefined;
    try {
      await assertControlPlaneStagedSources({ lock, staging, sources });
      console.log("[local upgrade] Validating pinned images and private configuration");
      await probeControlPlaneImages(runner, config, { nativeGit: join(staging.path, "native-git.json"), execution: join(staging.path, "execution.json") });
      await probeControlPlanePublishedAddresses(runner, config, { nativeGit: prior.record.nativeGitPublish, execution: prior.record.executionPublish });
      await mkdir(resolve(backupRoot), { recursive: true, mode: 0o700 });
      await mkdir(backupDirectory, { mode: 0o700 });
      await writeFile(join(backupDirectory, "prior-install.json"), prior.installBytes, { mode: 0o600, flag: "wx" });
      await writeFile(join(backupDirectory, "prior-compose.yml"), prior.composeBytes, { mode: 0o600, flag: "wx" });
      console.log("[local upgrade] Stopping both services for a consistent checkpoint");
      stopped = true;
      await stopOwnedServices(runner, config.deploymentId);
      await writeFile(join(backupDirectory, "phase-stopped"), "", { mode: 0o600, flag: "wx" });
      checkpoints = await checkpointVolumes(runner, prior.record.executionImage, backupDirectory);
      await writeFile(join(backupDirectory, "recovery.json"), `${JSON.stringify({ schemaVersion: 1, stateRoot: lock.root,
        priorGenerationId: prior.record.generationId, checkpoints }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      console.log(`[local upgrade] Both volume checkpoints retained at ${backupDirectory}`);
      await forwardReadable(runner, config.nativeGit.image, "native-git");
      await forwardReadable(runner, config.execution.image, "execution");
      candidate = await finalizeControlPlaneGeneration({ lock, staging, config, sources: completeControlPlaneSourcePreflight(sources, {
        nativeGit: activationTokenBytes(randomBytes), execution: activationTokenBytes(randomBytes)
      }) });
      await writeFile(join(backupDirectory, `phase-candidate-${candidate.generationId}`), "", { mode: 0o600, flag: "wx" });
      const compose = await createControlPlaneComposeFile(candidate.composeBytes);
      try {
        await validateControlPlaneCompose(runner, compose.path);
        console.log("[local upgrade] Starting the candidate generation");
        await runControlPlaneUpdate({ runner, candidate, composePath: compose.path });
        await publishControlPlaneInstalledState(lock, candidate, { volumesEstablished: true });
        console.log("[local upgrade] Activating the recorded candidate generation");
        await activateControlPlaneCandidate(runner, candidate);
        await completeControlPlaneInstalledState(lock, candidate);
        committed = true;
      } finally { await compose.close(); }
    } catch (error) {
      if (committed) throw new Error(`new generation is active; temporary cleanup failed; checkpoints: ${backupDirectory}`, { cause: error });
      if (candidate === undefined) {
        if (stopped) await runDocker(runner, ["container", "start", owned.executionContainerId, owned.nativeGitContainerId]);
        await discardControlPlaneStaging(lock, staging);
      }
      else {
        console.log("[local upgrade] Saving bounded candidate diagnostics privately in the checkpoint");
        try {
          const failed = await inspectControlPlaneDocker(runner, config.deploymentId, true);
          if (failed.kind === "owned") await captureServiceLogs(runner, backupDirectory, failed);
        } catch { /* Diagnostics are best effort and must not block recovery. */ }
        console.log("[local upgrade] Candidate failed; stopping it before restoring both checkpoints");
        await stopOwnedServices(runner, config.deploymentId);
        if (checkpoints === undefined) throw new Error("candidate recovery has no complete checkpoint pair", { cause: error });
        await restoreVolumes(runner, prior.record.executionImage, backupDirectory, checkpoints);
        await writeFile(join(backupDirectory, "phase-data-restored"), "", { mode: 0o600 });
        console.log("[local upgrade] Both prior volume checkpoints restored; restoring the prior generation");
        await rollbackControlPlaneUpdate({ lock, runner, candidate, prior, error });
      }
      // Failed/uncertain restoration keeps the journal and checkpoints for recovery.
      throw new Error(`local control-plane upgrade failed; recovery evidence: ${backupDirectory}`, { cause: error });
    }
    await writeFile(join(backupDirectory, "phase-complete"), "", { mode: 0o600, flag: "wx" });
    console.log(`[local upgrade] Generation ${candidate.generationId} installed; checkpoints retained at ${backupDirectory}`);
    return candidate.generationId;
  } finally { await lock.close(); }
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const [config, state, backups] = process.argv.slice(2);
  if (!config || !state || process.argv.length > 5) throw new Error("Usage: node --import ./tests/node_modules/tsx/dist/loader.mjs --conditions=dim-source scripts/upgrade-local-control-plane.ts INSTALL_JSON INSTALLER_STATE_ROOT [BACKUP_ROOT]");
  await upgradeLocalControlPlane(config, state, backups ?? resolve(".local/backups"));
}
