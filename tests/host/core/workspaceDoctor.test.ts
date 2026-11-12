import { describe, expect, it } from "vitest";
import { workspaceRuntimeFailureCheck } from "@slop-lab/dim-host-core/workspace";

describe("workspace host doctor runtime failure diagnostics", () => {
  it("reports the exact Sysbox time namespace startup incompatibility", () => {
    const failures = [{
      name: "dev",
      runtime: "container", phase: "error",
      error: 'at start runtime: Docker failed: namespace {"time" ""} does not exist',
    }];

    const check = workspaceRuntimeFailureCheck(failures);

    expect(check).toMatchObject({ name: "Sysbox startup compatibility", ok: false });
    expect(check?.detail).toContain("dev");
    expect(check?.detail).toContain("features.time-namespaces=false");
    expect(check?.detail).toContain("idle host");
    expect(check?.detail).toContain("restart Docker");
  });

  it.each([
    'namespace {"time_for_children" ""} does not exist',
    'namespace {"time" "unexpected"} does not exist',
    'namespace {"time" ""} already exists',
    "Docker daemon is unavailable",
  ])("does not infer the incompatibility from a near-miss failure: %s", (error) => {
    const failures = [{ name: "dev", runtime: "container", phase: "error", error: `at start runtime: ${error}` }];

    const check = workspaceRuntimeFailureCheck(failures);

    expect(check).toBeUndefined();
  });

  it.each([
    { runtime: "vm", phase: "error", stage: "at start runtime:" },
    { runtime: "container", phase: "running", stage: "Integration preparation failed:" },
    { runtime: "container", phase: "error", stage: "at acquire source:" },
  ])("does not recommend host repair for unrelated runtime or stage: $runtime $phase $stage", (input) => {
    expect(workspaceRuntimeFailureCheck([{ name: "dev", ...input, error: `${input.stage} namespace {\"time\" \"\"} does not exist` }])).toBeUndefined();
  });
});
