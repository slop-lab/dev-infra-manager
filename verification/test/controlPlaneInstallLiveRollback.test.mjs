import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  LiveRollbackFailureRunner,
  OneShotPublicationFault
} from "../scripts/control-plane-install-live-rollback.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("control-plane live rollback injection", () => {
  it.each([
    ["ordinary-startup", [replacement("ordinary-ci")]],
    ["ordinary-readiness", [replacement("ordinary-ci"), readiness("ordinary-ci")]],
    ["native-startup", [replacement("ordinary-ci"), readiness("ordinary-ci"), replacement("native-git")]],
    ["native-dependency-readiness", [replacement("ordinary-ci"), readiness("ordinary-ci"), replacement("native-git"), readiness("native-git")]]
  ])("alters exactly one result after the real command for %s", async (stage, commands) => {
    // Given
    const calls = [];
    const delegate = { async run(command) { calls.push(command); return successful(); } };
    const runner = new LiveRollbackFailureRunner(delegate, { kind: "restore", stage });

    // When
    const results = [];
    for (const command of commands) results.push(await runner.run(command));

    // Then
    assert.equal(calls.length, commands.length);
    assert.equal(results.filter(({ exitCode }) => exitCode === 75).length, 1);
    assert.equal(runner.injections, 1);
  });

  it("throws one uncertain shutdown result only after the real rollback replacement", async () => {
    // Given
    const calls = [];
    const delegate = { async run(command) { calls.push(command); return successful(); } };
    const runner = new LiveRollbackFailureRunner(delegate, {
      kind: "replacement-shutdown-halt",
      uncertainError: () => new TypeError("injected uncertain shutdown")
    });
    const commands = [
      replacement("ordinary-ci"), readiness("ordinary-ci"), replacement("native-git"),
      readiness("native-git"), replacement("ordinary-ci")
    ];

    // When
    const failures = [];
    for (const command of commands) {
      try { await runner.run(command); } catch (error) { failures.push(error); }
    }

    // Then
    assert.equal(calls.length, commands.length);
    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /uncertain shutdown/);
    assert.equal(runner.injections, 2);
  });

  it("fails one publication replacement and restores the exact prior file for rollback", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-live-publication-fault-"));
    temporaryRoots.push(root);
    const composePath = join(root, "compose.yml");
    const transactionPath = join(root, "transaction.json");
    const prior = Buffer.from("prior compose bytes\n");
    await writeFile(composePath, prior, { mode: 0o600 });
    await writeFile(transactionPath, "generation\n", { mode: 0o600 });
    const fault = new OneShotPublicationFault(root);
    fault.arm();

    // When
    await replaceFile(transactionPath, Buffer.from("publishing\n"));
    await assert.rejects(replaceFile(composePath, Buffer.from("candidate compose bytes\n")));
    await fault.restored;

    // Then
    assert.deepEqual(await readFile(composePath), prior);
    await replaceFile(composePath, prior);
    assert.equal(fault.injections, 1);
  });
});

function replacement(service) {
  return { args: ["compose", "--force-recreate", service] };
}

function readiness(service) {
  const user = service === "ordinary-ci" ? "10002:10002" : "10001:10001";
  return { args: ["container", "exec", "--user", user, `${service}-id`, "/usr/local/bin/dim-service", "ready"] };
}

function successful() {
  return { exitCode: 0, stdout: "", stderr: "" };
}

async function replaceFile(path, bytes) {
  const temporary = `${path}.tmp-test`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try { await rename(temporary, path); }
  catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
