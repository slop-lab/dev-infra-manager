import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertIdleAuthorityBoundary } from "./control-plane-install-live-evidence.mjs";
import { captureRollbackState } from "./control-plane-install-live-rollback.mjs";
import { runLiveRoleDenialMatrix } from "./control-plane-install-live-roles.mjs";

const injectedFailure = {
  exitCode: 75,
  stdout: "",
  stderr: "injected prepublication native readiness failure\n"
};

export class PrepublicationFailureRunner {
  injections = 0;
  rollbackStarted = false;
  candidateReady;
  #candidateReadyResolved = false;
  #delegate;
  #ordinaryCandidateId;
  #prior;
  #release;
  #released;
  #replacements = 0;

  constructor(delegate, prior) {
    this.#delegate = delegate;
    this.#prior = prior;
    this.candidateReady = new Promise((resolve) => { this.#candidateReadyResolved = resolve; });
    this.#released = new Promise((resolve) => { this.#release = resolve; });
  }

  release() {
    this.#release();
  }

  async run(command) {
    const result = await this.#delegate.run(command);
    const replacementService = replacement(command.args);
    if (replacementService !== undefined) {
      this.#replacements += 1;
      if (this.#replacements >= 3 && replacementService === "ordinary-ci") this.rollbackStarted = true;
      return result;
    }
    if (this.rollbackStarted || !cleanSuccess(result)) return result;
    const ready = readiness(command.args);
    if (this.#replacements === 1 && ready?.service === "ordinary-ci"
      && ready.id !== this.#prior.ordinaryCi.id) {
      this.#ordinaryCandidateId = ready.id;
      return result;
    }
    if (this.#replacements !== 2 || ready?.service !== "native-git"
      || ready.id === this.#prior.nativeGit.id || this.#ordinaryCandidateId === undefined) return result;
    if (this.#candidateReadyResolved !== false) {
      this.#candidateReadyResolved({
        nativeGitId: ready.id,
        ordinaryCiId: this.#ordinaryCandidateId
      });
      this.#candidateReadyResolved = false;
      await this.#released;
    }
    this.injections += 1;
    return injectedFailure;
  }
}

export async function runLivePrepublicationGate(input) {
  await input.selectCandidate();
  const failureRunner = new PrepublicationFailureRunner(input.runner, input.prior.runtime);
  const installOutcome = input.install(failureRunner).then(
    (value) => ({ kind: "success", value }),
    (error) => ({ kind: "failure", error })
  );
  let candidate;
  let inspectionError;
  try {
    candidate = await bounded(failureRunner.candidateReady, 30_000, "candidate native readiness barrier");
    await assertPrepublicationState(input, candidate);
  } catch (error) {
    inspectionError = error;
  } finally {
    failureRunner.release();
  }

  const outcome = await bounded(installOutcome, 150_000, "prepublication rollback");
  assert.equal(outcome.kind, "failure", "prepublication failure unexpectedly installed the candidate");
  assert.match(outcome.error.message, /exact prior generation was restored/);
  assert.equal(failureRunner.injections, 1);
  assert.equal(failureRunner.rollbackStarted, true);
  const restored = await assertRestoredState(input, candidate);
  if (inspectionError !== undefined) throw inspectionError;
  return restored;
}

async function assertPrepublicationState(input, candidate) {
  const [runtime, installBytes, composeBytes, volumes, before] = await Promise.all([
    input.captureRuntime(),
    readFile(join(input.stateRoot, "install.json")),
    readFile(join(input.stateRoot, "compose.yml")),
    input.captureVolumes(),
    input.captureState()
  ]);
  const generationId = runtime.nativeGit.generationId;
  assert.equal(runtime.nativeGit.id, candidate.nativeGitId);
  assert.equal(runtime.ordinaryCi.id, candidate.ordinaryCiId);
  assert.equal(runtime.ordinaryCi.generationId, generationId);
  assert.notEqual(generationId, input.prior.state.generationId);
  assert.equal(runtime.nativeGit.image, input.candidateImages.nativeGit);
  assert.equal(runtime.ordinaryCi.image, input.candidateImages.ordinaryCi);
  assert.equal(installBytes.toString("base64"), input.prior.state.installBase64);
  assert.equal(composeBytes.toString("base64"), input.prior.state.composeBase64);
  assert.deepEqual(volumes, input.prior.volumes);
  assert.deepEqual(before.services, input.prior.authority.services);
  assert.equal(before.services.nativeGit.activationGenerations.includes(generationId), false);
  assert.equal(before.services.ordinaryCi.activationGenerations.includes(generationId), false);
  assertIdleAuthorityBoundary(before);
  await input.assertSentinels();
  await runLiveRoleDenialMatrix({
    nativePort: input.nativePort,
    ordinaryPort: input.ordinaryPort,
    credentials: input.credentials,
    runner: input.runner,
    expectedProjectResources: input.prior.authority.projectResources
  });
  const after = await input.captureState();
  assert.deepEqual(after.services, before.services);
  assert.equal((await readFile(join(input.stateRoot, "install.json"))).toString("base64"), input.prior.state.installBase64);
  assert.equal((await readFile(join(input.stateRoot, "compose.yml"))).toString("base64"), input.prior.state.composeBase64);
  console.log(`prepublication-candidates ${JSON.stringify({
    generationId, nativeGitId: candidate.nativeGitId, ordinaryCiId: candidate.ordinaryCiId,
    priorInstallSha256: input.prior.state.installSha256,
    priorComposeSha256: input.prior.state.composeSha256,
    before: before.services, after: after.services
  })}`);
}

async function assertRestoredState(input, candidate) {
  const [state, runtime, volumes, authority] = await Promise.all([
    captureRollbackState(input.stateRoot), input.captureRuntime(), input.captureVolumes(), input.captureState()
  ]);
  assert.deepEqual(state, input.prior.state);
  assert.deepEqual(volumes, input.prior.volumes);
  assertRuntimeGeneration(runtime, input.prior.runtime);
  assert.notEqual(runtime.nativeGit.id, candidate?.nativeGitId);
  assert.notEqual(runtime.ordinaryCi.id, candidate?.ordinaryCiId);
  assert.deepEqual(authority.services, input.prior.authority.services);
  await assert.rejects(access(join(input.stateRoot, "transaction.json")), { code: "ENOENT" });
  await input.assertSentinels();
  console.log(`prepublication-rollback ${JSON.stringify({
    status: "restored", generationId: state.generationId,
    installSha256: state.installSha256, composeSha256: state.composeSha256,
    runtime, volumes, authority: authority.services, transaction: "absent"
  })}`);
  return runtime;
}

function assertRuntimeGeneration(actual, expected) {
  for (const service of ["nativeGit", "ordinaryCi"]) {
    assert.equal(actual[service].image, expected[service].image);
    assert.equal(actual[service].generationId, expected[service].generationId);
  }
}

function replacement(args) {
  if (args[0] !== "compose" || !args.includes("--force-recreate")) return undefined;
  const service = args.at(-1);
  return service === "native-git" || service === "ordinary-ci" ? service : undefined;
}

function readiness(args) {
  if (args.length !== 7 || args[0] !== "container" || args[1] !== "exec" || args[2] !== "--user"
    || args[5] !== "/usr/local/bin/dim-service" || args[6] !== "ready") return undefined;
  if (args[3] === "10001:10001") return { service: "native-git", id: args[4] };
  if (args[3] === "10002:10002") return { service: "ordinary-ci", id: args[4] };
  return undefined;
}

function cleanSuccess(result) {
  return result.exitCode === 0 && result.stdout === "" && result.stderr === "";
}

async function bounded(promise, timeoutMilliseconds, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMilliseconds}ms`)), timeoutMilliseconds);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
