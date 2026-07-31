import { describe, expect, it } from "vitest";
import {
  BUILTIN_CI_RUNNER_DEFAULTS,
  ciRunnerContainerArgs,
  ciRunnerContainerName,
  effectiveCiRunnerResources
} from "../src/ciRunner.js";
import { giteaCiRunnerApiBase } from "../src/giteaCiCoordinator.js";
import type { CiRunnerRecord, LifecycleOptions } from "../src/lifecycleTypes.js";

const options = {
  ciRunnerDefaultCpus: BUILTIN_CI_RUNNER_DEFAULTS.cpus,
  ciRunnerDefaultMemory: BUILTIN_CI_RUNNER_DEFAULTS.memory,
  ciRunnerDefaultPidsLimit: BUILTIN_CI_RUNNER_DEFAULTS.pidsLimit
} as LifecycleOptions;

describe("CI runner resources", () => {
  it("uses configured defaults and marks them inherited", () => {
    expect(effectiveCiRunnerResources(options, undefined, {
      cpus: "6",
      memory: "12GiB",
      pidsLimit: "4096"
    })).toEqual({
      resources: { cpus: "6", memory: "12GiB", pidsLimit: "4096" },
      inheritsResources: true
    });
  });

  it("applies project overrides without changing unspecified defaults", () => {
    expect(effectiveCiRunnerResources(options, { memory: "16GiB" }, {
      cpus: "6",
      memory: "12GiB",
      pidsLimit: "4096"
    })).toEqual({
      resources: { cpus: "6", memory: "16GiB", pidsLimit: "4096" },
      inheritsResources: false
    });
  });

  it("derives stable managed resource names", () => {
    expect(ciRunnerContainerName("example")).toBe("dim-ci-example");
    expect(() => ciRunnerContainerName("../bad")).toThrow(/project name/);
  });

  it("registers the Project runner at organization scope", () => {
    expect(giteaCiRunnerApiBase({
      gitNamespace: "dim-example"
    })).toBe("/orgs/dim-example/actions/runners");
  });

  it("applies the runner boundary without mounting the host Docker socket", () => {
    const record = {
      projectName: "example",
      containerName: "dim-ci-example",
      volumeName: "dim-ci-example-data",
      image: "runner:image",
      runtime: "sysbox-runc",
      resources: { cpus: "4", memory: "8g", pidsLimit: "2048" }
    } as CiRunnerRecord;
    const args = ciRunnerContainerArgs(record, { instanceUrl: "http://coordinator", token: "secret" });
    expect(args).toContain("sysbox-runc");
    expect(args).toContain("4");
    expect(args).toContain("8g");
    expect(args).toContain("2048");
    expect(args.join(" ")).not.toContain("/var/run/docker.sock");
    expect(args.join(" ")).toContain("dim:docker://gitea/runner-images:ubuntu-24.04");
    expect(args.join(" ")).toContain("ubuntu-24.04:docker://gitea/runner-images:ubuntu-24.04");
  });
});
