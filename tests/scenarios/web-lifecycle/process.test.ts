import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { CommandFailure, runCommand } from "./process.js";

describe("CommandFailure", () => {
  it("Given private stderr, when a command fails, then the Error message remains fixed", () => {
    const failure = new CommandFailure("dim", ["create"], { exitCode: 2, stdout: "", stderr: "token=PRIVATE_SECRET /private/path" });
    expect(failure.message).toBe("command failed (2)");
    expect(failure.message).not.toContain("PRIVATE_SECRET");
  });

  it("Given excessive command output, when the bound is crossed, then execution fails without retaining output", async () => {
    await expect(runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(1024))"], { maxOutputBytes: 16 }))
      .rejects.toMatchObject({ name: "CommandFailure", message: "command failed (1)", result: { stdout: "", stderr: "output limit exceeded" } });
  });
});

// Each Node 24/26 source lane must exercise the same direct loader used by VMs.
it("loads the VM command helper with bare Node and preserves failure details", () => {
  const program = `
    import assert from 'node:assert/strict';
    const { CommandFailure, runCommand } = await import(${JSON.stringify(new URL("./process.ts", import.meta.url).href)});
    const argv = ['-e', "process.stdout.write('output'); process.stderr.write('private diagnostic'); process.exit(23)"];
    await assert.rejects(runCommand(process.execPath, argv), (error) => {
      assert.ok(error instanceof CommandFailure);
      assert.equal(error.message, 'command failed (23)');
      assert.equal(error.file, process.execPath);
      assert.deepEqual(error.arguments_, argv);
      assert.deepEqual(error.result, {exitCode: 23, stdout: 'output', stderr: 'private diagnostic'});
      return true;
    });
    const result = await runCommand(process.execPath, argv, {acceptFailure: true});
    assert.equal(result.exitCode, 23);
    process.stdout.write('bare-node-helper-ok');
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8", timeout: 10_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("bare-node-helper-ok");
});
