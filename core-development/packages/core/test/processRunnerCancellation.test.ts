import { describe, expect, it } from "vitest";
import { ProcessRunner } from "../../../../core/packages/core/src/runner.js";

describe("process runner cancellation", () => {
  it("escalates from SIGTERM to SIGKILL when a command ignores graceful termination", async () => {
    // Given
    const controller = new AbortController();
    const runner = new ProcessRunner();
    const startedAt = Date.now();
    const running = runner.run("env", ["--ignore-signal=TERM", "sleep", "60"], {
      signal: controller.signal
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // When
    controller.abort();
    const result = await running;

    // Then
    expect(result.exitCode).toBe(137);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});
