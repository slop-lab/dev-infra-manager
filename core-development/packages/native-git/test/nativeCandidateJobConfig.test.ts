import { describe, expect, it } from "vitest";
import {
  candidateArgv,
  parseNativeCandidateJobConfig,
  type NativeCandidateRequiredJob
} from "../../../../core/packages/native-git/src/index.js";

const requiredJobs = [
  { name: "source", kind: "ordinary-sysbox" },
  { name: "lint", kind: "ordinary-sysbox" },
  { name: "integration", kind: "qemu" }
] as const satisfies readonly NativeCandidateRequiredJob[];

function validConfig(): string {
  return `schemaVersion: 4
ordinary:
  jobs:
    source:
      script: .dim/ci/jobs/source.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
    lint:
      script: .dim/ci/jobs/lint.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
qemu:
  jobs:
    integration:
      script: .dim/ci/jobs/integration.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
`;
}

describe("native schema-4 candidate job config", () => {
  it("returns canonical job maps and a deterministic kind-labelled plan", () => {
    // Given
    const bytes = Buffer.from(validConfig(), "utf8");

    // When
    const config = parseNativeCandidateJobConfig(bytes, [requiredJobs[2], requiredJobs[0], requiredJobs[1]]);

    // Then
    expect(config).toEqual({
      schemaVersion: 4,
      ordinary: {
        jobs: {
          lint: { script: ".dim/ci/jobs/lint.bash", argv: candidateArgv },
          source: { script: ".dim/ci/jobs/source.bash", argv: candidateArgv }
        }
      },
      qemu: {
        jobs: {
          integration: { script: ".dim/ci/jobs/integration.bash", argv: candidateArgv }
        }
      },
      plan: [
        { name: "lint", kind: "ordinary-sysbox", script: ".dim/ci/jobs/lint.bash", argv: candidateArgv },
        { name: "source", kind: "ordinary-sysbox", script: ".dim/ci/jobs/source.bash", argv: candidateArgv },
        { name: "integration", kind: "qemu", script: ".dim/ci/jobs/integration.bash", argv: candidateArgv }
      ]
    });
    expect(Object.keys(config.ordinary.jobs)).toEqual(["lint", "source"]);
    expect(Object.keys(config.qemu.jobs)).toEqual(["integration"]);
  });

  it("accepts one required kind while keeping the other map separate and empty", () => {
    // Given
    const bytes = Buffer.from(validConfig()
      .replace("    lint:\n      script: .dim/ci/jobs/lint.bash\n      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]\n", "")
      .replace("    source:\n      script: .dim/ci/jobs/source.bash\n      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]\n", "")
      .replace("  jobs:\nqemu:", "  jobs: {}\nqemu:"));

    // When
    const config = parseNativeCandidateJobConfig(bytes, [{ name: "integration", kind: "qemu" }]);

    // Then
    expect(config.ordinary.jobs).toEqual({});
    expect(config.plan).toEqual([
      { name: "integration", kind: "qemu", script: ".dim/ci/jobs/integration.bash", argv: candidateArgv }
    ]);
  });

  it("accepts a different safe flat script for the exact QEMU job", () => {
    // Given: the candidate selects a distinct flat script inside the jobs directory.
    const bytes = Buffer.from(validConfig().replace(
      ".dim/ci/jobs/integration.bash", ".dim/ci/jobs/suite.bash"
    ));

    // When: both job-kind sets are matched against trusted policy.
    const config = parseNativeCandidateJobConfig(bytes, requiredJobs);

    // Then: only the QEMU job points to its selected script.
    expect(config.qemu.jobs.integration?.script).toBe(".dim/ci/jobs/suite.bash");
    expect(config.ordinary.jobs.source?.script).toBe(".dim/ci/jobs/source.bash");
  });
});
