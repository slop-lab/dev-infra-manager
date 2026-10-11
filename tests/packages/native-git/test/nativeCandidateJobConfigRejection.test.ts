import { describe, expect, it } from "vitest";
import {
  CandidateExecutionError,
  parseNativeCandidateJobConfig,
  type NativeCandidateRequiredJob
} from "../../../../core/packages/native-git/src/index.js";
import { parseCandidateConfig } from "../../../../core/packages/native-git/src/candidate-execution-schema.js";

const requiredJobs = [
  { name: "source", kind: "ordinary-sysbox" },
  { name: "integration", kind: "qemu" }
] as const satisfies readonly NativeCandidateRequiredJob[];

function validConfig(): string {
  return `schemaVersion: 4
ordinary:
  jobs:
    source:
      script: .dim/ci/jobs/source.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
qemu:
  jobs:
    integration:
      script: .dim/ci/jobs/integration.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
`;
}

function rejects(bytes: Buffer, jobs: readonly NativeCandidateRequiredJob[] = requiredJobs): void {
  expect(() => parseNativeCandidateJobConfig(bytes, jobs)).toThrow(CandidateExecutionError);
}

describe("native schema-4 candidate job config rejection", () => {
  it("keeps the active schema-3 parser from accepting schema 4", () => {
    // Given
    const bytes = Buffer.from(validConfig(), "utf8");

    // When / Then
    expect(() => parseCandidateConfig(bytes)).toThrow(CandidateExecutionError);
  });

  it.each([
    ["schema 3", validConfig().replace("schemaVersion: 4", "schemaVersion: 3")],
    ["schema 2", validConfig().replace("schemaVersion: 4", "schemaVersion: 2")],
    ["a top-level field", `${validConfig()}image: candidate\n`],
    ["an ordinary section field", validConfig().replace("ordinary:\n", "ordinary:\n  bounds: {}\n")],
    ["a job field", validConfig().replace("      script: .dim/ci/jobs/source.bash", "      extra: value\n      script: .dim/ci/jobs/source.bash")],
    ["a duplicate key", `${validConfig()}schemaVersion: 4\n`],
    ["an alias", `job: &job\n  script: .dim/ci/jobs/source.bash\n  argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]\n${validConfig().replace("    source:\n      script: .dim/ci/jobs/source.bash\n      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]", "    source: *job")}`],
    ["an anchor", validConfig().replace("    source:", "    source: &source")],
    ["an explicit tag", validConfig().replace("schemaVersion: 4", "schemaVersion: !!int 4")],
    ["a merge key", validConfig().replace("      script: .dim/ci/jobs/source.bash", "      <<: {}\n      script: .dim/ci/jobs/source.bash")],
    ["a modified argv", validConfig().replace("/run/dim/job/script", "/workspace/script")],
    ["extra argv", validConfig().replace("/run/dim/job/script]", "/run/dim/job/script, unexpected]")],
    ["an unsafe job name", validConfig().replace("    source:", "    ../source:")],
    ["a traversing script", validConfig().replace(".dim/ci/jobs/source.bash", ".dim/ci/jobs/../source.bash")],
    ["a nested script", validConfig().replace(".dim/ci/jobs/source.bash", ".dim/ci/jobs/nested/source.bash")],
    ["a script with whitespace", validConfig().replace(".dim/ci/jobs/source.bash", ".dim/ci/jobs/source test.bash")]
  ])("rejects %s", (_label, source) => {
    // Given / When / Then
    rejects(Buffer.from(source, "utf8"));
  });

  it.each(["image", "bounds", "env", "mounts", "network", "url", "hostCommand", "credential"])(
    "rejects candidate-selected %s authority",
    (field) => {
      // Given
      const source = validConfig().replace(
        "      script: .dim/ci/jobs/source.bash",
        `      ${field}: candidate-controlled\n      script: .dim/ci/jobs/source.bash`
      );

      // When / Then
      rejects(Buffer.from(source, "utf8"));
    }
  );

  it("rejects non-UTF-8, NUL, and oversized buffers", () => {
    // Given
    const invalidUtf8 = Buffer.from([0xc3, 0x28]);
    const nul = Buffer.from(`${validConfig()}\0`, "utf8");
    const oversized = Buffer.from(`${validConfig()}#${"x".repeat(65_536)}`, "utf8");

    // When / Then
    rejects(invalidUtf8);
    rejects(nul);
    rejects(oversized);
  });

  it.each([
    ["missing ordinary job", validConfig().replace("    source:\n      script: .dim/ci/jobs/source.bash\n      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]\n", "")],
    ["extra ordinary job", validConfig().replace("    source:", "    extra:\n      script: .dim/ci/jobs/extra.bash\n      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]\n    source:")],
    ["missing QEMU job", validConfig().replace("    integration:\n      script: .dim/ci/jobs/integration.bash\n      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]\n", "")],
    ["extra QEMU job", validConfig().replace("    integration:", "    extra:\n      script: .dim/ci/jobs/extra.bash\n      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]\n    integration:")]
  ])("rejects a policy mismatch with a %s", (_label, source) => {
    // Given / When / Then
    rejects(Buffer.from(source, "utf8"));
  });

  it("rejects overlapping candidate names and overlapping trusted names", () => {
    // Given
    const overlappingConfig = validConfig().replace("    integration:", "    source:");
    const overlappingPolicy = [
      { name: "source", kind: "ordinary-sysbox" },
      { name: "source", kind: "qemu" }
    ] as const;

    // When / Then
    rejects(Buffer.from(overlappingConfig, "utf8"), overlappingPolicy);
    rejects(Buffer.from(validConfig(), "utf8"), overlappingPolicy);
  });

  it("rejects invalid trusted required-job sets", () => {
    // Given
    const duplicate = [requiredJobs[0], requiredJobs[0]];
    const unsafe = [{ name: "../source", kind: "ordinary-sysbox" }] as const;
    const tooMany = Array.from({ length: 65 }, (_value, index) => ({
      name: `job-${index}`,
      kind: "ordinary-sysbox" as const
    }));

    // When / Then
    rejects(Buffer.from(validConfig()), []);
    rejects(Buffer.from(validConfig()), duplicate);
    rejects(Buffer.from(validConfig()), unsafe);
    rejects(Buffer.from(validConfig()), tooMany);
  });
});
