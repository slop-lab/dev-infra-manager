import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adminBuiltinCall } from "../../../../core/packages/core/src/adminBuiltin.js";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { registerPlugins } from "../../../../core/packages/core/src/plugin.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

describe("admin host mirror admission", () => {
  it("denies workspace reconciliation before Docker when no host provider is enabled", async () => {
    // Given
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-admin-mirror-test-"));
    const plugins = await registerPlugins([]);
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command, args): Promise<CommandResult> {
        calls.push([command, ...args]);
        return { command, args, stdout: "", stderr: "", exitCode: 0 };
      },
      async runStreaming(): Promise<number> { return 0; }
    };

    try {
      // When
      const operation = adminBuiltinCall("workspace.start", {
        input: { name: "work-1" },
        lifecycle: lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: stateRoot }),
        runner,
        plugins
      });

      // Then
      await expect(operation).rejects.toThrow(/requires one enabled host mirror provider/);
      expect(calls).toEqual([]);
    } finally {
      await plugins.dispose();
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
