import { describe, expect, it } from "vitest";
import { boundedCiRunnerResourceName } from "../../../../core/packages/core/src/ciRunnerVolume.js";
import { ciRunnerContainerName } from "../../../../core/packages/core/src/sysboxCiRunnerLifecycle.js";

describe("CI runner resource names", () => {
  it("keeps delimiter-ambiguous valid Project and runner tuples distinct", () => {
    const projectWithDelimiter = ciRunnerContainerName("a-b", "c");
    const runnerWithDelimiter = ciRunnerContainerName("a", "b-c");

    expect(projectWithDelimiter).not.toBe(runnerWithDelimiter);
    expect(projectWithDelimiter).toMatch(/^dim-ci-a-b-c-[0-9a-f]{16}$/);
    expect(runnerWithDelimiter).toMatch(/^dim-ci-a-b-c-[0-9a-f]{16}$/);
  });

  it.each([
    ["short", "runner"],
    ["p".repeat(48), "r".repeat(48)]
  ])("derives a deterministic valid bounded name for %s input", (project, runner) => {
    const parts = ["dim", "ci", project, runner];
    const first = boundedCiRunnerResourceName(parts);
    const second = boundedCiRunnerResourceName(parts);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-z0-9][a-z0-9_.-]{0,62}$/);
    expect(first).toMatch(/-[0-9a-f]{16}$/);
    expect(first.length).toBeLessThanOrEqual(63);
  });
});
