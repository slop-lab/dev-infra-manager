import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runChangedDeploymentDenial, runOccupiedPortDenial, runPreInstallDenials } from "./control-plane-install-live-denials.mjs";
import { captureRollbackState, runLiveRollbackMatrix } from "./control-plane-install-live-rollback.mjs";
import { runMissingEstablishedVolume } from "./control-plane-install-live-missing-volume.mjs";
import { runLivePrepublicationGate } from "./control-plane-install-live-prepublication.mjs";
import { inspectEffectiveCompose, runMissingComposeHarness, runWrongDigestDenial } from "./control-plane-install-live-integrity.mjs";
import { installWithFacade, unusedPort } from "./control-plane-install-live-support.mjs";
import { runBuiltImageReadinessMatrix, runDependencyReadinessTransition } from "./control-plane-install-live-readiness.mjs";
import { captureAuthorityBoundaryState } from "./control-plane-install-live-evidence.mjs";
import { parseCompatibilityVariantManifest, runLiveCandidateCompatibilityDenials, runLivePriorCompatibilityDenials } from "./control-plane-install-live-compatibility.mjs";
import { controlPlaneFacadeEnvironment, createOperatorFixture, digestReference, requiredEnvironment } from "./control-plane-install-live-fixture.mjs";
import { runImmutableSourceEvidence, runPublishOnlyEvidence } from "./control-plane-install-live-mutation.mjs";
import { assertQemuPredecessorPreserved, runPredecessorPreflight } from "./control-plane-install-live-predecessor.mjs";
import { assertDockerCli, createLiveRuntime } from "./control-plane-install-live-runtime.mjs";
import { runIsolatedFacadeNoOp } from "./control-plane-install-live-isolated.mjs";

const root = requiredEnvironment("HARNESS_ROOT"); const deploymentId = requiredEnvironment("DEPLOYMENT_ID");
const blockerName = requiredEnvironment("BLOCKER_NAME");
const verificationId = requiredEnvironment("VERIFICATION_ID");
const images = {
  g1: { nativeGit: digestReference("G1_NATIVE"), ordinaryCi: digestReference("G1_ORDINARY") },
  g2: { nativeGit: digestReference("G2_NATIVE"), ordinaryCi: digestReference("G2_ORDINARY") }
};
const { installControlPlane, ProcessControlPlaneDockerRunner } = await import(pathToFileURL(join(root, "installer", "install.js")).href);
const { ControlPlaneDockerUncertainError } = await import(pathToFileURL(join(root, "installer", "controlPlaneDocker.js")).href);
const { controlPlaneFailureCode } = await import(pathToFileURL(join(root, "installer", "controlPlaneInstallError.js")).href);
const runner = new ProcessControlPlaneDockerRunner();
const {
  assertBusinessUnavailable,
  assertDeployment,
  assertSentinels,
  docker,
  projectResources,
  runtimeSnapshot,
  volumeSnapshot,
  writeSentinels
} = createLiveRuntime({ runner, deploymentId });
const operatorRoot = join(root, "operator"); const stateHome = join(root, "state-home");
const lifecycleStateRoot = join(root, "lifecycle-state"); const stateRoot = join(stateHome, "dim", "control-plane");
const configPath = join(operatorRoot, "install.json");
const facade = join(root, "installer", "dim");
const nativePort = await unusedPort(); const ordinaryPort = await unusedPort();
const changedNativePort = await unusedPort(); const projectBefore = await projectResources();
const hostileBin = join(operatorRoot, "hostile-bin"); const hostileDockerMarker = join(operatorRoot, "hostile-docker-selected");
const compatibilityVariants = parseCompatibilityVariantManifest(
  await readFile(join(root, "compatibility-variants.tsv"), "utf8")
);

await mkdir(operatorRoot, { recursive: true, mode: 0o700 });
await mkdir(hostileBin, { mode: 0o700 });
await writeFile(join(hostileBin, "docker"), `#!/bin/sh\n: > '${hostileDockerMarker}'\nexit 97\n`, { mode: 0o700 });
await assertDockerCli(runner);
const { credentials, readinessTokens, sources, writeConfig } = await createOperatorFixture({
  operatorRoot,
  configPath,
  deploymentId,
  ports: { nativeGit: nativePort, ordinaryCi: ordinaryPort }
});
const facadeInstall = {
  executable: facade,
  configPath,
  stateRoot,
  cwd: operatorRoot,
  environment: controlPlaneFacadeEnvironment({ environment: process.env, home: operatorRoot,
    path: `${hostileBin}:${process.env.PATH ?? ""}`, stateHome, lifecycleStateRoot }),
  forbiddenOutput: Object.values(credentials)
};
const imageProbeTokenPath = join(root, "image-readiness.token");
const imageProbeToken = randomBytes(32).toString("base64url");
await writeFile(imageProbeTokenPath, `${imageProbeToken}\n`, { mode: 0o444 });
await chmod(imageProbeTokenPath, 0o444);
const imageProbeTokenMetadata = await lstat(imageProbeTokenPath);
assert.equal(imageProbeTokenMetadata.isFile(), true);
assert.equal(imageProbeTokenMetadata.mode & 0o777, 0o444);
await runBuiltImageReadinessMatrix({
  runner,
  images: images.g1,
  tokenPath: imageProbeTokenPath,
  forbiddenValues: [...Object.values(credentials), ...Object.values(readinessTokens), imageProbeToken],
  writeLine: console.log
});
console.log("built-image-readiness token=private-bind mode=0444 argv=redacted output=redacted");
const denialContext = {
  configPath, stateRoot, sources, runner, deploymentId, verificationId, facadeInput: facadeInstall
};
await writeConfig(images.g1);
const predecessor = await runPredecessorPreflight({ ...denialContext, lifecycleStateRoot });
await runPreInstallDenials(denialContext);
await runWrongDigestDenial(denialContext, images.g1.nativeGit);
await runMissingComposeHarness({
  runner,
  root,
  deploymentId,
  verificationId,
  containerName: requiredEnvironment("NO_COMPOSE_NAME"),
  image: requiredEnvironment("NO_COMPOSE_IMAGE"),
  harnessVolume: requiredEnvironment("HARNESS_VOLUME"),
  daemonSocketSource: requiredEnvironment("DAEMON_SOCKET_SOURCE")
});
const blocker = await docker([
  "container", "run", "--detach", "--name", blockerName,
  "--label", `org.dim.verification=${verificationId}`,
  "--network", "bridge", "--publish", "127.0.0.1::8080",
  "--entrypoint", "node", images.g1.nativeGit,
  "--input-type=module", "--eval", "setInterval(() => {}, 60000)"
]);
const blockedPort = Number((await docker(["container", "port", blockerName, "8080/tcp"])).stdout.trim().split(":").at(-1));
assert.equal(Number.isInteger(blockedPort), true);
await writeConfig(images.g1, { nativeGit: blockedPort, ordinaryCi: ordinaryPort });
await runOccupiedPortDenial(denialContext);
await docker(["container", "rm", "--force", blocker.stdout.trim()]);
await assert.rejects(docker(["container", "inspect", blockerName]));
console.log(`occupied-port blocker=${blockedPort} blocker-cleaned=true`);
await writeConfig(images.g1);

const compatibilityInput = {
  variants: compatibilityVariants,
  priorImages: images.g1,
  candidateImages: images.g2,
  denialContext,
  deploymentId,
  writeConfig,
  captureRuntime: runtimeSnapshot,
  captureVolumes: volumeSnapshot,
  assertDeployment,
  installApi: async (probeRunner) => installControlPlane({ configPath, stateRoot, runner: probeRunner }),
  assertSentinels: async (insert) => insert ? writeSentinels() : assertSentinels()
};
await runLivePriorCompatibilityDenials(compatibilityInput);

const first = await installWithFacade(facadeInstall);
await assertQemuPredecessorPreserved(predecessor);
await assert.rejects(access(hostileDockerMarker));
await assertDeployment(first, images.g1);
await inspectEffectiveCompose({
  runner,
  stateRoot,
  record: first.record,
  operatorPaths: [configPath, ...Object.values(sources)],
  forbiddenValues: [...Object.values(credentials), ...Object.values(readinessTokens)]
});
const firstRuntime = await runtimeSnapshot();
const firstInstallBytes = await readFile(join(stateRoot, "install.json"));
const firstComposeBytes = await readFile(join(stateRoot, "compose.yml"));
const firstVolumes = await volumeSnapshot();
await writeSentinels();
await assertSentinels();
await assertBusinessUnavailable(nativePort);
console.log(`first-install generation=${first.record.generationId} native=${firstRuntime.nativeGit.id} ordinary=${firstRuntime.ordinaryCi.id} hostile-path-marker=absent`);
await runImmutableSourceEvidence({
  sourcePath: sources.nativeGit,
  generationPath: join(stateRoot, "generations", first.record.generationId),
  runner, runtime: firstRuntime, captureRuntime: runtimeSnapshot, captureVolumes: volumeSnapshot,
  captureState: async () => captureAuthorityBoundaryState(runner),
  assertSentinels, writeLine: console.log
});
await runLiveCandidateCompatibilityDenials(compatibilityInput);
console.log("compatibility-coverage not-live=none reason=all-requested-candidate-and-safe-prior-cases-ran-live");

await runIsolatedFacadeNoOp({
  runner, root, stateRoot, forbiddenValues: [...Object.values(credentials), ...Object.values(readinessTokens)],
  prior: { generationId: first.record.generationId, runtime: firstRuntime, volumes: firstVolumes,
    installBytes: firstInstallBytes, composeBytes: firstComposeBytes },
  captureRuntime: runtimeSnapshot, captureVolumes: volumeSnapshot, assertSentinels
});
await runChangedDeploymentDenial(denialContext);
await runPublishOnlyEvidence({
  stateRoot, sources, runner, docker, blockerName, verificationId,
  images: images.g1, oldNativePort: nativePort, newPort: changedNativePort, ordinaryPort,
  writeConfig, installApi: async (probeRunner) => installControlPlane({ configPath, stateRoot, runner: probeRunner }),
  prior: { installed: first, runtime: firstRuntime, volumes: firstVolumes, installBytes: firstInstallBytes, composeBytes: firstComposeBytes },
  captureRuntime: runtimeSnapshot, captureVolumes: volumeSnapshot, captureState: async () => captureAuthorityBoundaryState(runner),
  assertSentinels, assertDeployment, writeLine: console.log,
  assertCompose: async (installed) => inspectEffectiveCompose({
    runner, stateRoot, record: installed.record, operatorPaths: [configPath, ...Object.values(sources)],
    forbiddenValues: [...Object.values(credentials), ...Object.values(readinessTokens)]
  })
});

await writeConfig(images.g2);
const second = await installWithFacade(facadeInstall);
assert.notEqual(second.record.generationId, first.record.generationId);
await assertDeployment(second, images.g2);
const secondRuntime = await runtimeSnapshot();
assert.notEqual(secondRuntime.nativeGit.id, firstRuntime.nativeGit.id);
assert.notEqual(secondRuntime.ordinaryCi.id, firstRuntime.ordinaryCi.id);
assert.deepEqual(await volumeSnapshot(), firstVolumes);
await assertSentinels();
await assertBusinessUnavailable(nativePort);
console.log(`update generation=${second.record.generationId} native=${secondRuntime.nativeGit.id} ordinary=${secondRuntime.ordinaryCi.id}`);
const dependencyState = await captureAuthorityBoundaryState(runner);
await runDependencyReadinessTransition({
  runner,
  runtime: secondRuntime,
  volumes: firstVolumes,
  state: dependencyState,
  captureRuntime: runtimeSnapshot,
  captureVolumes: volumeSnapshot,
  captureState: async () => captureAuthorityBoundaryState(runner),
  writeLine: console.log
});
await assertSentinels();
const priorRollbackState = await captureRollbackState(stateRoot);
const restoredRuntime = await runLivePrepublicationGate({
  stateRoot, runner, candidateImages: images.g1, nativePort, ordinaryPort, credentials,
  prior: { state: priorRollbackState, runtime: secondRuntime, volumes: firstVolumes, authority: dependencyState },
  selectCandidate: async () => writeConfig(images.g1),
  install: async (failureRunner) => installControlPlane({ configPath, stateRoot, runner: failureRunner,
    readinessPolicy: { timeoutMilliseconds: 60_000, retryIntervalMilliseconds: 60_000, execTimeoutMilliseconds: 3_000 } }),
  captureRuntime: runtimeSnapshot, captureVolumes: volumeSnapshot,
  captureState: async () => captureAuthorityBoundaryState(runner), assertSentinels
});

await runLiveRollbackMatrix({
  stateRoot,
  runner,
  prior: { state: priorRollbackState, runtime: restoredRuntime, volumes: firstVolumes },
  selectCandidate: async () => writeConfig(images.g1),
  install: async (failureRunner) => installControlPlane({
    configPath, stateRoot, runner: failureRunner,
    readinessPolicy: { timeoutMilliseconds: 2000, retryIntervalMilliseconds: 2000, execTimeoutMilliseconds: 1000 }
  }),
  captureRuntime: runtimeSnapshot,
  captureVolumes: volumeSnapshot,
  failureCode: controlPlaneFailureCode,
  uncertainError: () => new ControlPlaneDockerUncertainError("injected replacement shutdown uncertainty"),
  assertStable: async () => {
    await assertSentinels();
    await assertBusinessUnavailable(nativePort);
    assert.deepEqual(await projectResources(), projectBefore);
  },
  repair: async () => {
    for (const service of ["ordinary-ci", "native-git"]) {
      await docker([
        "compose", "--project-name", "dim-control-plane", "--file", join(stateRoot, "compose.yml"),
        "up", "--detach", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", service
      ]);
    }
    await unlink(join(stateRoot, "transaction.json"));
    await writeConfig(images.g2);
    await installControlPlane({ configPath, stateRoot, runner });
    console.log("rollback-halt-repair prior-generation-restored=true journal-cleared=true volumes-preserved=true");
  }
});
await runMissingEstablishedVolume({
  stateRoot,
  runner,
  facadeInput: facadeInstall,
  deploymentId,
  verificationId,
  probeName: requiredEnvironment("VOLUME_PROBE_NAME"),
  probeImage: images.g2.ordinaryCi
});
