import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserError } from "../../../../core/packages/core/src/errors.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { setupWorkspace } from "../../../../core/packages/core/src/workspaceSetup.js";
import { restartWorkspace, startWorkspace, updateWorkspace
} from "../../../../core/packages/core/src/workspaceTransitions.js";
import { hostLifecycleOptions } from "./hostLifecycleFixture.js";

const options = hostLifecycleOptions("/state");
const readFailure = new UserError("lifecycle record malformed: not found in expected structure");
const calls: string[][] = [];
const runner = {
  async run(command: string, args: string[]) {
    calls.push([command, ...args]);
    return { command, args, stdout: "", stderr: "", exitCode: 0 };
  },
  async runStreaming(command: string, args: string[]) {
    calls.push([command, ...args]);
    return 0;
  }
} satisfies StreamingCommandRunner;

beforeEach(() => {
  vi.restoreAllMocks();
  calls.length = 0;
});

describe("workspace record absence callers", () => {
  it("attributes setup read failures containing not found without runtime dispatch", async () => {
    vi.spyOn(LifecycleState.prototype, "readWorkspace").mockRejectedValue(readFailure);
    await expect(setupWorkspace(runner, options, "workspace")).rejects.toMatchObject({
      message: `workspace setup at workspace state loading: ${readFailure.message}`,
      cause: readFailure
    });
    expect(calls).toEqual([]);
  });

  it.each([
    { operation: "update", invoke: () => updateWorkspace(runner, options, "workspace") },
    { operation: "start", invoke: () => startWorkspace(runner, options, "workspace") },
    { operation: "restart", invoke: () => restartWorkspace(runner, options, "workspace") }
  ])("attributes $operation read failures containing not found without runtime dispatch", async ({ operation, invoke }) => {
    vi.spyOn(LifecycleState.prototype, "readWorkspace").mockRejectedValue(readFailure);
    await expect(invoke()).rejects.toMatchObject({
      message: `workspace ${operation} at workspace state loading: ${readFailure.message}`,
      cause: readFailure
    });
    expect(calls).toEqual([]);
  });
});
