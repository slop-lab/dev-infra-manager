import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  watch
} from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const failedResult = {
  exitCode: 75,
  stdout: "",
  stderr: "injected live rollback boundary failure\n"
};

export const restorationStages = [
  "ordinary-startup",
  "ordinary-readiness",
  "native-startup",
  "native-dependency-readiness",
  "installed-state-publication"
];

export class LiveRollbackFailureRunner {
  replacements = 0;
  injections = 0;
  events = [];
  #delegate;
  #scenario;
  #primaryInjected = false;

  constructor(delegate, scenario) {
    this.#delegate = delegate;
    this.#scenario = scenario;
  }

  async run(command) {
    const result = await this.#delegate.run(command);
    const replacementService = replacement(command.args);
    if (replacementService !== undefined) {
      this.replacements += 1;
      this.events.push(`replace:${this.replacements}:${replacementService}`);
      if (this.#injectStartup(replacementService)) return this.#failure(`startup:${replacementService}`);
      if (this.#scenario.kind === "replacement-shutdown-halt" && this.replacements === 3) {
        this.injections += 1;
        this.events.push("inject:rollback-replacement-shutdown");
        throw this.#scenario.uncertainError();
      }
      return result;
    }

    const readyService = readiness(command.args);
    if (readyService !== undefined) {
      this.events.push(`ready:${this.replacements}:${readyService}`);
      if (this.#injectCandidateReadiness(readyService)) return this.#failure(`readiness:${readyService}`);
      if (this.#scenario.kind === "prior-readiness-halt" && this.replacements === 3
        && readyService === "ordinary-ci") {
        return this.#failure("rollback-readiness:ordinary-ci");
      }
      if (this.#scenario.kind === "restore" && this.#scenario.stage === "installed-state-publication"
        && this.replacements === 2 && readyService === "native-git") {
        this.#scenario.publicationFault.arm();
        this.events.push("arm:installed-state-publication");
      }
      return result;
    }

    const activatedService = activation(command.args);
    if (activatedService !== undefined) this.events.push(`activate:${activatedService}`);
    return result;
  }

  #injectStartup(service) {
    if (this.#scenario.kind !== "restore" || this.#primaryInjected) return false;
    return (this.#scenario.stage === "ordinary-startup" && this.replacements === 1 && service === "ordinary-ci")
      || (this.#scenario.stage === "native-startup" && this.replacements === 2 && service === "native-git");
  }

  #injectCandidateReadiness(service) {
    if (this.#primaryInjected) return false;
    const restoreFailure = this.#scenario.kind === "restore"
      && ((this.#scenario.stage === "ordinary-readiness" && this.replacements === 1 && service === "ordinary-ci")
        || (this.#scenario.stage === "native-dependency-readiness" && this.replacements === 2 && service === "native-git"));
    const haltTrigger = (this.#scenario.kind === "replacement-shutdown-halt"
      || this.#scenario.kind === "prior-readiness-halt")
      && this.replacements === 2 && service === "native-git";
    return restoreFailure || haltTrigger;
  }

  #failure(label) {
    this.#primaryInjected = true;
    this.injections += 1;
    this.events.push(`inject:${label}`);
    return failedResult;
  }
}

export class OneShotPublicationFault {
  injections = 0;
  restored;
  #resolve;
  #reject;
  #root;
  #watcher;

  constructor(root) {
    this.#root = root;
    this.restored = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  arm() {
    assert.equal(this.#watcher, undefined, "publication fault must be armed once");
    const compose = join(this.#root, "compose.yml");
    const prior = join(this.#root, ".publication-fault-prior-compose.yml");
    this.#watcher = watch(this.#root, (event, filename) => {
      try {
        if (event !== "rename" || filename === null) return;
        if (filename === "transaction.json" && this.injections === 0) {
          renameSync(compose, prior);
          mkdirSync(compose, { mode: 0o700 });
          this.injections = 1;
          return;
        }
        if (this.injections === 1 && filename.startsWith("compose.yml.tmp-")
          && !existsSync(join(this.#root, filename))) {
          rmSync(compose, { recursive: true });
          renameSync(prior, compose);
          this.#watcher?.close();
          this.#resolve();
        }
      } catch (error) {
        this.#watcher?.close();
        this.#reject(error);
      }
    });
  }
}

export async function captureRollbackState(stateRoot) {
  const install = await readFile(join(stateRoot, "install.json"));
  const compose = await readFile(join(stateRoot, "compose.yml"));
  const record = JSON.parse(install.toString("utf8"));
  return {
    generationId: record.generationId,
    installBase64: install.toString("base64"),
    installSha256: digest(install),
    composeBase64: compose.toString("base64"),
    composeSha256: digest(compose),
    snapshots: await captureGenerationSnapshots(stateRoot, record.generationId)
  };
}

export async function captureGenerationSnapshots(stateRoot, generationId) {
  const generationPath = join(stateRoot, "generations", generationId);
  const snapshotNames = (await readdir(generationPath)).sort();
  assert.deepEqual(snapshotNames, [
    "native-git-activation.token", "native-git-readiness.token", "native-git.json",
    "ordinary-ci-activation.token", "ordinary-ci-readiness.token", "ordinary-ci.json"
  ]);
  return Object.fromEntries(await Promise.all(snapshotNames.map(async (name) => {
    const bytes = await readFile(join(generationPath, name));
    return [basename(name), digest(bytes)];
  })));
}

export async function runLiveRollbackMatrix(context) {
  for (const stage of restorationStages) {
    await context.selectCandidate();
    const publicationFault = stage === "installed-state-publication"
      ? new OneShotPublicationFault(context.stateRoot)
      : undefined;
    const scenario = { kind: "restore", stage, ...(publicationFault === undefined ? {} : { publicationFault }) };
    const failureRunner = new LiveRollbackFailureRunner(context.runner, scenario);
    const error = await context.install(failureRunner).catch((failure) => failure);
    assert.equal(error instanceof Error, true, `${stage} unexpectedly reported success`);
    assert.match(error.message, /exact prior generation was restored/);
    if (publicationFault !== undefined) await publicationFault.restored;
    const [after, runtime, volumes] = await Promise.all([
      captureRollbackState(context.stateRoot), context.captureRuntime(), context.captureVolumes()
    ]);
    assert.deepEqual(after, context.prior.state);
    assert.deepEqual(volumes, context.prior.volumes);
    assertRuntimeGeneration(runtime, context.prior.runtime);
    assert.notEqual(runtime.nativeGit.id, context.prior.runtime.nativeGit.id);
    assert.notEqual(runtime.ordinaryCi.id, context.prior.runtime.ordinaryCi.id);
    const rollbackOrdinary = stage.startsWith("ordinary") ? 2 : 3;
    assert.deepEqual(failureRunner.events.slice(-6), [
      `replace:${rollbackOrdinary}:ordinary-ci`, `ready:${rollbackOrdinary}:ordinary-ci`,
      `replace:${rollbackOrdinary + 1}:native-git`, `ready:${rollbackOrdinary + 1}:native-git`,
      "activate:ordinary-ci", "activate:native-git"
    ]);
    assert.equal(failureRunner.injections + (publicationFault?.injections ?? 0), 1);
    await context.assertStable();
    console.log(`rollback-stage ${JSON.stringify({
      stage, status: "restored", failureCategory: context.failureCode(error.cause),
      before: context.prior.state, after, runtimeBefore: context.prior.runtime, runtimeAfter: runtime,
      volumesBefore: context.prior.volumes, volumesAfter: volumes, order: failureRunner.events
    })}`);
  }

  for (const kind of ["prior-readiness-halt", "replacement-shutdown-halt"]) {
    await context.selectCandidate();
    const scenario = kind === "replacement-shutdown-halt"
      ? { kind, uncertainError: context.uncertainError }
      : { kind };
    const failureRunner = new LiveRollbackFailureRunner(context.runner, scenario);
    const error = await context.install(failureRunner).catch((failure) => failure);
    assert.equal(error instanceof Error, true, `${kind} unexpectedly reported success`);
    assert.match(error.message, /update and rollback failed/);
    assert.equal(error.details?.kind, "rollback");
    const after = await captureRollbackState(context.stateRoot);
    assert.deepEqual(after, context.prior.state);
    const journal = JSON.parse(await readFile(join(context.stateRoot, "transaction.json"), "utf8"));
    assert.equal(journal.prior.installBase64, context.prior.state.installBase64);
    assert.equal(journal.prior.composeBase64, context.prior.state.composeBase64);
    assert.equal(journal.prior.generationId, context.prior.state.generationId);
    const candidateSnapshots = await captureGenerationSnapshots(context.stateRoot, journal.candidateGenerationId);
    const generations = await readdir(join(context.stateRoot, "generations"));
    assert.equal(generations.includes(context.prior.state.generationId), true);
    assert.equal(generations.includes(journal.candidateGenerationId), true);
    const [runtime, volumes] = await Promise.all([context.captureRuntime(), context.captureVolumes()]);
    assert.deepEqual(volumes, context.prior.volumes);
    assert.equal(failureRunner.events.some((event) => event.startsWith("activate:")), false);
    await context.assertStable();
    console.log(`rollback-halt ${JSON.stringify({
      stage: kind, status: "halted", originalFailureCategory: error.details.originalCode,
      rollbackFailureCategory: error.details.rollbackCode, prior: after,
      candidateGeneration: journal.candidateGenerationId, candidateSnapshots,
      runtimeBefore: context.prior.runtime, runtimeAfter: runtime,
      volumesBefore: context.prior.volumes, volumesAfter: volumes, journal: "retained", order: failureRunner.events
    })}`);
    await context.repair();
  }
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
  if (args[0] !== "container" || args[1] !== "exec" || args.at(-1) !== "ready") return undefined;
  if (args[3] === "10001:10001") return "native-git";
  if (args[3] === "10002:10002") return "ordinary-ci";
  return undefined;
}

function activation(args) {
  if (args[0] !== "container" || args[1] !== "exec" || args.at(-2) !== "activate") return undefined;
  if (args[3] === "10001:10001") return "native-git";
  if (args[3] === "10002:10002") return "ordinary-ci";
  return undefined;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
