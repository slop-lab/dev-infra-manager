import { describe, expect, it } from "vitest";
import { ciRunnerLabels, parseCiRunnerConfigYaml, qemuCiRunnerLabels } from "../../../../core/packages/core/src/ciRunnerConfig.js";
import { QEMU_CI_SUPERVISOR_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerSupervisorAssets.js";
import {
  SYSBOX_CI_RUNNER_CONFIG,
  SYSBOX_CI_RUNNER_DOCKERFILE
} from "../../../../core/packages/core/src/sysboxCiRunnerAssets.js";

const runnerImage = "gitea/runner-images@sha256:27c8a8f3eeaee2ae642ecf82736b7e3b29d066ff064589f2a4092692ae19b8a8";
const config = parseCiRunnerConfigYaml(`schemaVersion: 1
workloads:
  ordinary: {labels: [dim, ubuntu-24.04], image: ${runnerImage}, tools: [bash], capabilities: []}
  integration: {labels: [dim-container-integration], image: ${runnerImage}, tools: [bash, docker], capabilities: [nested-docker]}
`);
const labels = ciRunnerLabels(config);

describe("CI runner role separation", () => {
  it("advertises only ordinary workloads on persistent Sysbox capacity", () => {
    expect(labels).toBe([
      `dim:docker://${runnerImage}`,
      `ubuntu-24.04:docker://${runnerImage}`
    ].join(","));
  });

  it("advertises integration labels and dim-qemu on QEMU capacity", () => {
    expect(qemuCiRunnerLabels(config)).toBe([
      `dim-container-integration:docker://${runnerImage}`,
      `dim-qemu:docker://${runnerImage}`
    ].join(","));
  });

  it("never advertises host-mode workloads", () => {
    expect(labels.split(",").filter((label) => label.endsWith(":host"))).toEqual([]);
    expect(QEMU_CI_SUPERVISOR_SCRIPT).not.toContain(":host");
  });

  it("keeps general Project build tooling out of the Sysbox host image", () => {
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).not.toMatch(/\b(?:just|jq|npm|pnpm|socat|script)\b/);
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).not.toMatch(/(?:package\.json|node_modules|git clone|pip install|util-linux-misc)/);
  });

  it("locks act_runner docker jobs to DIM-owned safe settings", () => {
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).toContain("COPY config.yml /etc/dim-act-runner.yml");
    expect(SYSBOX_CI_RUNNER_CONFIG).toContain("privileged: false");
    expect(SYSBOX_CI_RUNNER_CONFIG).toContain("valid_volumes: []");
    expect(SYSBOX_CI_RUNNER_CONFIG).toContain("docker_host: '-'");
    expect(SYSBOX_CI_RUNNER_CONFIG).not.toContain("/var/run/docker.sock");
    expect(SYSBOX_CI_RUNNER_CONFIG).toContain("force_pull: true");
    expect(SYSBOX_CI_RUNNER_CONFIG).toContain("bind_workdir: true");
    expect(SYSBOX_CI_RUNNER_CONFIG).not.toContain("'**'");
  });
});
