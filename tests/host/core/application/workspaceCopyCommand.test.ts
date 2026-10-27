import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { registerWorkspaceCopyCommand } from "../../../../packages/host/core/src/application/commands/copy.js";
const run = vi.hoisted(() => vi.fn(async () => 0));
vi.mock("../../../../packages/host/core/src/application/commands/operations.js", () => ({ runStreamOperation: run }));
afterEach(() => { run.mockClear(); process.exitCode = undefined; });
it.each(["1-test", "foo_bar", "foo.bar", "x".repeat(48)])("accepts lifecycle-valid workspace name %s in the host stream command", async (name) => {
  const command = new Command(); registerWorkspaceCopyCommand(command);
  await command.parseAsync(["node", "dim", "cp", "-", `${name}:directory/file`, "--expect-id", "fixed-id"]);
  expect(run).toHaveBeenCalledWith({ operation: "copy", input: { name, path: "directory/file", direction: "receive", recursive: false, overwrite: false, expectedId: "fixed-id" } });
});
it.each(["Upper", "x".repeat(49), "bad/name"])("rejects invalid lifecycle name %s before executing", async (name) => {
  const command = new Command(); registerWorkspaceCopyCommand(command);
  await expect(command.parseAsync(["node", "dim", "cp", "-", `${name}:file`, "--expect-id", "fixed-id"])).rejects.toThrow(/name must match/);
  expect(run).not.toHaveBeenCalled();
});
