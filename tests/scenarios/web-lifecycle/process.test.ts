import { describe, expect, it } from "vitest";
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
