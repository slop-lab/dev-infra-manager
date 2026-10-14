import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const regression = resolve(import.meta.dirname, "../scripts/verification-stage-runner-test.bash");

describe("verification stage runner", () => {
  it("passes cancellation and fatal-cleanup regressions through the executable driver", () => {
    // Given the production runner's executable regression driver
    // When
    const result = spawnSync("/usr/bin/bash", [regression], { encoding: "utf8" });
    // Then
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("verification-stage-runner-test-ok");
  }, 15_000);
});
