import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { PrepublicationFailureRunner } from "../scripts/control-plane-install-live-prepublication.mjs";

describe("control-plane live prepublication barrier", () => {
  it("pauses only after successful candidate native readiness and fails its returned result", async () => {
    // Given
    const calls = [];
    const delegate = { async run(command) { calls.push(command); return successful(); } };
    const runner = new PrepublicationFailureRunner(delegate, {
      nativeGit: { id: "prior-native" }, ordinaryCi: { id: "prior-ordinary" }
    });
    await runner.run(replacement("ordinary-ci"));
    await runner.run(readiness("ordinary-ci", "candidate-ordinary"));
    await runner.run(replacement("native-git"));

    // When
    let settled = false;
    const readinessResult = runner.run(readiness("native-git", "candidate-native"))
      .then((result) => { settled = true; return result; });
    const candidate = await runner.candidateReady;

    // Then
    assert.deepEqual(candidate, { nativeGitId: "candidate-native", ordinaryCiId: "candidate-ordinary" });
    assert.equal(calls.length, 4);
    assert.equal(settled, false);
    runner.release();
    assert.equal((await readinessResult).exitCode, 75);
    assert.equal(runner.injections, 1);
  });

  it("does not pause or alter failed native readiness", async () => {
    // Given
    const delegate = { async run(command) {
      return command.args.at(-1) === "ready" ? { exitCode: 1, stdout: "", stderr: "not ready\n" } : successful();
    } };
    const runner = new PrepublicationFailureRunner(delegate, {
      nativeGit: { id: "prior-native" }, ordinaryCi: { id: "prior-ordinary" }
    });
    await runner.run(replacement("ordinary-ci"));
    await runner.run(replacement("native-git"));

    // When
    const result = await runner.run(readiness("native-git", "candidate-native"));

    // Then
    assert.equal(result.exitCode, 1);
    assert.equal(runner.injections, 0);
  });

  it("stops altering readiness as soon as rollback replacement begins", async () => {
    // Given
    const delegate = { async run() { return successful(); } };
    const runner = new PrepublicationFailureRunner(delegate, {
      nativeGit: { id: "prior-native" }, ordinaryCi: { id: "prior-ordinary" }
    });
    await runner.run(replacement("ordinary-ci"));
    await runner.run(readiness("ordinary-ci", "candidate-ordinary"));
    await runner.run(replacement("native-git"));
    const candidateReady = runner.run(readiness("native-git", "candidate-native"));
    await runner.candidateReady;
    runner.release();
    await candidateReady;

    // When
    await runner.run(replacement("ordinary-ci"));
    const priorResult = await runner.run(readiness("native-git", "restored-native"));

    // Then
    assert.equal(priorResult.exitCode, 0);
    assert.equal(runner.rollbackStarted, true);
    assert.equal(runner.injections, 1);
  });
});

function replacement(service) {
  return { args: ["compose", "--force-recreate", service] };
}

function readiness(service, id) {
  const user = service === "ordinary-ci" ? "10002:10002" : "10001:10001";
  return { args: ["container", "exec", "--user", user, id, "/usr/local/bin/dim-service", "ready"] };
}

function successful() {
  return { exitCode: 0, stdout: "", stderr: "" };
}
