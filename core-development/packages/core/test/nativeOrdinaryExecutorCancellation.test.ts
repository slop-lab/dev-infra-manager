import { describe, expect, it, vi } from "vitest";
import { executeNativeHostClaim } from "../../../../core/packages/core/src/nativeOrdinaryExecutor.js";
import { dependencies, execution, ExecutorRunner } from "./nativeOrdinaryExecutorFixture.js";

describe("native ordinary executor observer cancellation", () => {
  it("settles stalled Docker logs before owned cleanup and fenced recovery", async () => {
    // Given
    const runner = new ExecutorRunner();
    const cancellation = new AbortController();
    runner.abortOnWait = cancellation;
    runner.logsWaitForAbort = true;
    const reportResult = vi.fn(async () => { throw new Error("reporter unavailable"); });
    const recoverClaim = vi.fn();

    // When
    const completed = await executeNativeHostClaim({
      ...dependencies(runner), reportResult, recoverClaim
    }, { ...execution(), signal: cancellation.signal });

    // Then
    expect(completed.disposition).toBe("recovered");
    expect(reportResult).toHaveBeenCalledTimes(3);
    expect(recoverClaim).toHaveBeenCalledOnce();
    expect(runner.calls.filter((call) => call.args[0] === "container").map((call) => call.args.slice(0, 3))).toEqual([
      ["container", "inspect", expect.any(String)],
      ["container", "rm", "--force"]
    ]);
  });
});
