import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { captureRollbackState } from "./control-plane-install-live-rollback.mjs";
import { runFacadeCommand } from "./control-plane-install-live-support.mjs";

export async function runLiveActivationRecovery(context) {
  await context.selectCandidate();
  const lostAcknowledgement = new LostNativeActivationAcknowledgement(context.runner);
  const error = await context.install(lostAcknowledgement).catch((failure) => failure);
  assert.equal(error instanceof Error, true);
  assert.match(error.message, /activation outcome is uncertain/);
  assert.equal(lostAcknowledgement.injections, 1);
  const journalPath = join(context.stateRoot, "transaction.json");
  const retainedJournal = await readFile(journalPath);
  const candidate = await captureRollbackState(context.stateRoot);
  assert.notEqual(candidate.generationId, context.priorGenerationId);
  const retainedRuntime = await context.captureRuntime();
  const retainedVolumes = await context.captureVolumes();
  assert.deepEqual(retainedVolumes, context.priorVolumes);
  await context.assertSentinels();

  const wrongGeneration = await runFacadeCommand(context.facadeInput, [
    "installer", "recover", "control-plane", "--roll-forward", "--generation", "0".repeat(64)
  ]);
  assert.equal(wrongGeneration.exitCode, 1);
  assert.equal(wrongGeneration.stdout, "");
  assert.match(wrongGeneration.stderr, /recovery journal schema or identity is invalid/);
  assert.deepEqual(await readFile(journalPath), retainedJournal);
  assert.deepEqual(await context.captureRuntime(), retainedRuntime);

  const recovered = await runFacadeCommand(context.facadeInput, [
    "installer", "recover", "control-plane", "--roll-forward", "--generation", candidate.generationId
  ]);
  assert.equal(recovered.exitCode, 0, recovered.stderr);
  assert.equal(recovered.stderr, "");
  assert.equal(recovered.stdout,
    `Recovered control-plane generation ${candidate.generationId}\nServices: native-git, ordinary-ci\n`);
  await assert.rejects(readFile(journalPath), { code: "ENOENT" });
  assert.deepEqual(await captureRollbackState(context.stateRoot), candidate);
  assert.deepEqual(await context.captureRuntime(), retainedRuntime);
  assert.deepEqual(await context.captureVolumes(), retainedVolumes);
  await context.assertSentinels();
  console.log(`activation-roll-forward-smoke-ok generation=${candidate.generationId} containers=preserved volumes=preserved`);
}

class LostNativeActivationAcknowledgement {
  injections = 0;
  #delegate;

  constructor(delegate) {
    this.#delegate = delegate;
  }

  async run(command) {
    const result = await this.#delegate.run(command);
    if (this.injections === 0 && command.args[0] === "container" && command.args[1] === "exec"
      && command.args[3] === "10001:10001" && command.args[6] === "activate") {
      assert.equal(result.exitCode, 0);
      this.injections += 1;
      return { exitCode: 75, stdout: "", stderr: "injected lost native activation acknowledgement\n" };
    }
    return result;
  }
}
