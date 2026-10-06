import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const serviceDefinitions = [
  { key: "nativeGit", user: "10001:10001", snapshot: "native-git.json" },
  { key: "ordinaryCi", user: "10002:10002", snapshot: "ordinary-ci.json" }
];

export function createRecordingRunner(delegate, calls) {
  return {
    async run(command) {
      calls.push([...command.args]);
      return await delegate.run(command);
    }
  };
}

export function publicationProbeArguments(calls) {
  return calls.filter((args) => args[0] === "run" && args.includes("--rm") && args.includes("--publish"));
}

export async function runImmutableSourceEvidence(input) {
  const original = await readFile(input.sourcePath);
  const sourceBefore = digest(original);
  const before = await captureImmutableState(input);
  assert.deepEqual(before.runningHashes, before.snapshotHashes);
  let sourceMutated;
  let after;
  try {
    await writeFile(input.sourcePath, Buffer.concat([original, Buffer.from(" ")]));
    sourceMutated = digest(await readFile(input.sourcePath));
    assert.notEqual(sourceMutated, sourceBefore);
    after = await captureImmutableState(input);
    assert.deepEqual(after, before, "mutable operator source changed the running generation");
    await input.assertSentinels();
  } finally {
    await writeFile(input.sourcePath, original);
  }
  const sourceRestored = digest(await readFile(input.sourcePath));
  assert.equal(sourceRestored, sourceBefore);
  input.writeLine(`immutable-source ${JSON.stringify({
    sourceBefore, sourceMutated, sourceRestored,
    snapshotBefore: before.snapshotHashes,
    snapshotAfter: after.snapshotHashes,
    runningBefore: before.runningHashes,
    runningAfter: after.runningHashes,
    containerIds: runtimeIds(before.runtime),
    volumeIds: before.volumes,
    databaseState: before.authority.services
  })}`);
}

export async function runPublishOnlyEvidence(input) {
  const priorSources = await sourceHashes(input.sources);
  const priorAuthority = await input.captureState();
  await input.writeConfig(input.images, { nativeGit: input.newPort, ordinaryCi: input.ordinaryPort });
  const blocker = await input.docker([
    "container", "run", "--detach", "--name", input.blockerName,
    "--label", `org.dim.verification=${input.verificationId}`,
    "--network", "bridge", "--publish", `127.0.0.1:${input.newPort}:8080`,
    "--entrypoint", "node", input.images.nativeGit,
    "--input-type=module", "--eval", "setInterval(() => {}, 60000)"
  ]);
  const blockerId = blocker.stdout.trim();
  assert.match(blockerId, /^[0-9a-f]{64}$/);
  const blockedCalls = [];
  try {
    await assert.rejects(
      input.installApi(createRecordingRunner(input.runner, blockedCalls)),
      /preflight failed before resource mutation/
    );
    await assertPriorStable(input, priorSources, priorAuthority);
    assertPublishProbeSequence(input, blockedCalls, false);
  } finally {
    await input.docker(["container", "rm", "--force", blockerId]);
  }
  input.writeLine(`publish-only-occupied ${JSON.stringify({
    blockerId, port: input.newPort, changedPortProbeArgv: publicationProbeArguments(blockedCalls)[0],
    oldPortProbeArgv: null, ordinaryPortProbeArgv: null,
    generation: input.prior.installed.record.generationId,
    containerIds: runtimeIds(input.prior.runtime), volumeIds: input.prior.volumes,
    cleanup: "exact-id"
  })}`);

  const updateCalls = [];
  const updated = await input.installApi(createRecordingRunner(input.runner, updateCalls));
  assertPublishProbeSequence(input, updateCalls, true);
  assert.notEqual(updated.record.generationId, input.prior.installed.record.generationId);
  assert.equal(updated.record.nativeGitImage, input.images.nativeGit);
  assert.equal(updated.record.ordinaryCiImage, input.images.ordinaryCi);
  assert.deepEqual(updated.record.nativeGitPublish, { host: "127.0.0.1", port: input.newPort });
  assert.deepEqual(updated.record.ordinaryCiPublish, { host: "127.0.0.1", port: input.ordinaryPort });
  await input.assertDeployment(updated, input.images);
  await input.assertCompose(updated);
  const runtime = await input.captureRuntime();
  assert.notEqual(runtime.nativeGit.id, input.prior.runtime.nativeGit.id);
  assert.notEqual(runtime.ordinaryCi.id, input.prior.runtime.ordinaryCi.id);
  assert.deepEqual(await input.captureVolumes(), input.prior.volumes);
  assert.deepEqual(await sourceHashes(input.sources), priorSources);
  await input.assertSentinels();
  const probe = publicationProbeArguments(updateCalls)[0];
  input.writeLine(`publish-only-update ${JSON.stringify({
    priorGeneration: input.prior.installed.record.generationId,
    generation: updated.record.generationId,
    oldPortProbeArgv: null,
    newPortProbeArgv: probe,
    ordinaryPortProbeArgv: null,
    priorContainerIds: runtimeIds(input.prior.runtime),
    containerIds: runtimeIds(runtime),
    volumeIds: input.prior.volumes
  })}`);
  return { installed: updated, runtime };
}

async function captureImmutableState(input) {
  const [snapshotHashes, runningHashes, runtime, volumes, authority] = await Promise.all([
    generationConfigHashes(input.generationPath),
    runningConfigHashes(input.runner, input.runtime),
    input.captureRuntime(), input.captureVolumes(), input.captureState()
  ]);
  return { snapshotHashes, runningHashes, runtime, volumes, authority };
}

async function generationConfigHashes(generationPath) {
  return Object.fromEntries(await Promise.all(serviceDefinitions.map(async ({ key, snapshot }) => [
    key, digest(await readFile(join(generationPath, snapshot)))
  ])));
}

async function runningConfigHashes(runner, runtime) {
  return Object.fromEntries(await Promise.all(serviceDefinitions.map(async ({ key, user }) => {
    const source = "const{createHash}=require('node:crypto');const{readFileSync}=require('node:fs');process.stdout.write(createHash('sha256').update(readFileSync('/run/secrets/service.json')).digest('hex'))";
    const result = await runner.run({
      args: ["container", "exec", "--user", user, runtime[key].id, "node", "-e", source],
      timeoutMilliseconds: 30_000,
      maximumOutputBytes: 4096
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^[0-9a-f]{64}$/);
    return [key, result.stdout];
  })));
}

async function sourceHashes(sources) {
  return Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([name, path]) => [name, digest(await readFile(path))])));
}

async function assertPriorStable(input, priorSources, priorAuthority) {
  assert.deepEqual(await readFile(join(input.stateRoot, "install.json")), input.prior.installBytes);
  assert.deepEqual(await readFile(join(input.stateRoot, "compose.yml")), input.prior.composeBytes);
  assert.deepEqual(await input.captureRuntime(), input.prior.runtime);
  assert.deepEqual(await input.captureVolumes(), input.prior.volumes);
  assert.deepEqual(await sourceHashes(input.sources), priorSources);
  assert.deepEqual(await input.captureState(), priorAuthority);
  await input.assertSentinels();
}

function assertPublishProbeSequence(input, calls, expectReplacement) {
  const probes = publicationProbeArguments(calls);
  assert.equal(probes.length, 1);
  assert.equal(optionValue(probes[0], "--publish"), `127.0.0.1:${input.newPort}:8080`);
  assert.equal(calls.some((args) => args.includes(`127.0.0.1:${input.oldNativePort}:8080`)), false);
  assert.equal(calls.some((args) => args.includes(`127.0.0.1:${input.ordinaryPort}:8080`)), false);
  const replacement = calls.findIndex((args) => args.includes("--force-recreate"));
  if (expectReplacement) assert.equal(calls.findLastIndex((args) => args.includes("--publish")) < replacement, true);
  else assert.equal(replacement, -1);
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

function runtimeIds(runtime) {
  return { nativeGit: runtime.nativeGit.id, ordinaryCi: runtime.ordinaryCi.id };
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
