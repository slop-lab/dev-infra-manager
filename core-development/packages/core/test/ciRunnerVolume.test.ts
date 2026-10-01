import { describe, expect, it } from "vitest";
import {
  ciRunnerVolumeLabels,
  ensureCiRunnerVolume,
  removeCiRunnerVolume,
  type CiRunnerVolumePlan
} from "../../../../core/packages/core/src/ciRunnerVolume.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

const volumeCases = [
  {
    label: "Sysbox data",
    plan: { name: "dim-ci-example-sysbox", resource: "ci-runner-data", project: "example", projectId: "project-id" },
    values: ["true", "dim", "example", "project-id", "ci-runner-data", "volume", "9c45cf566ed06ccefb624aa00ef502369c61c05d955c4b719bb350ecfdcd9b07"]
  },
  {
    label: "QEMU capacity data",
    plan: { name: "dim-ci-example-qemu", resource: "ci-qemu-data", project: "example", projectId: "project-id" },
    values: ["true", "dim", "example", "project-id", "ci-qemu-data", "volume", "9c418cc4d04a1f2a1d428e5fc3e66e7f0f92fa741f7dd214de749bef5641b32f"]
  },
  {
    label: "QEMU dispatch",
    plan: { name: "dim-ci-example-dispatch", resource: "ci-qemu-dispatch", project: "example", projectId: "project-id" },
    values: ["true", "dim", "example", "project-id", "ci-qemu-dispatch", "volume", "695605269ef2328811dd7355fbd0ff6a17ccdf8b45a6f9b9e7e0cc51c216b2c4"]
  },
  {
    label: "QEMU common cache",
    plan: { name: "dim-ci-qemu-common-cache", resource: "ci-qemu-common-cache" },
    values: ["true", "dim", "host", "host", "ci-qemu-common-cache", "volume", "1e2fa939a24c3747fcbc5360c4ce1e671d5ba56f989352ba749029f8867e7cc8"]
  },
  {
    label: "QEMU Project cache",
    plan: { name: "dim-ci-example-qemu-cache", resource: "ci-qemu-project-cache", project: "example", projectId: "project-id" },
    values: ["true", "dim", "example", "project-id", "ci-qemu-project-cache", "volume", "2fe37bbfcc3e5b15cdd2d02e47dc2ef231e09b8f338b17400c83f11eb11d7a8e"]
  }
] as const satisfies readonly {
  readonly label: string;
  readonly plan: CiRunnerVolumePlan;
  readonly values: readonly [string, string, string, string, string, string, string];
}[];

const projectPlan = volumeCases[4].plan;
const volumeFields = ["managed", "owner", "project", "project-id", "resource", "kind", "digest"] as const;
const ownershipCases = volumeCases.flatMap((testCase) => volumeFields.map((field, index) => ({
  ...testCase,
  field,
  inspected: testCase.values.map((value, valueIndex) => valueIndex === index ? `foreign-${index}` : value).join("|")
})));

class VolumeRunner implements StreamingCommandRunner {
  readonly calls: { readonly command: string; readonly args: readonly string[] }[] = [];
  private readonly inspections: CommandResult[];

  constructor(inspect: CommandResult | readonly CommandResult[]) {
    this.inspections = Array.isArray(inspect) ? [...inspect] : [inspect];
  }

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    if (args[1] === "inspect") {
      const inspected = this.inspections.shift() ?? inspectResult("", 1, "No such volume");
      return { ...inspected, command, args };
    }
    return { command, args, stdout: args.at(-1) ?? "", stderr: "", exitCode: 0 };
  }

  async runStreaming(): Promise<number> {
    return 0;
  }
}

function inspectResult(stdout: string, exitCode = 0, stderr = ""): CommandResult {
  return { command: "docker", args: [], stdout, stderr, exitCode };
}

describe("CI runner volume ownership", () => {
  it("creates a missing Project volume with complete ownership labels", async () => {
    const expected = ciRunnerVolumeLabels(projectPlan).map((label) => label.slice(label.indexOf("=") + 1)).join("|");
    const runner = new VolumeRunner([
      inspectResult("", 1, "No such volume"),
      inspectResult(expected)
    ]);

    await ensureCiRunnerVolume(runner, projectPlan);

    expect(runner.calls[1]?.args).toEqual([
      "volume", "create",
      ...ciRunnerVolumeLabels(projectPlan).flatMap((label) => ["--label", label]),
      projectPlan.name
    ]);
  });

  it("labels the common QEMU cache as host-owned rather than Project-owned", async () => {
    const plan = { name: "dim-ci-qemu-common-cache", resource: "ci-qemu-common-cache" } satisfies CiRunnerVolumePlan;
    const expected = ciRunnerVolumeLabels(plan).map((label) => label.slice(label.indexOf("=") + 1)).join("|");
    const runner = new VolumeRunner([
      inspectResult("", 1, "No such volume"),
      inspectResult(expected)
    ]);

    await ensureCiRunnerVolume(runner, plan);

    expect(ciRunnerVolumeLabels(plan)).toEqual(expect.arrayContaining([
      "dim.managed=true",
      "dim.owner=dim",
      "dim.project=host",
      "dim.project-id=host",
      "dim.kind=volume",
      expect.stringMatching(/^dim\.digest=[0-9a-f]{64}$/)
    ]));
  });

  it.each(volumeCases)("matches the independent seven-field fixture for $label", ({ plan, values }) => {
    expect(ciRunnerVolumeLabels(plan).map(labelValue)).toEqual(values);
  });

  it.each(ownershipCases)("refuses a $label volume with only $field mismatched", async ({ plan, inspected }) => {
    const runner = new VolumeRunner(inspectResult(inspected));

    const ensure = ensureCiRunnerVolume(runner, plan);

    await expect(ensure).rejects.toThrow(/conflicts with DIM ownership/);
    expect(runner.calls).toHaveLength(1);
  });

  it.each(ownershipCases)("refuses to delete a $label volume with only $field mismatched", async ({ plan, inspected }) => {
    const runner = new VolumeRunner(inspectResult(inspected));

    const remove = removeCiRunnerVolume(runner, plan, testDescription(plan));

    await expect(remove).rejects.toThrow(/conflicts with DIM ownership/);
    expect(runner.calls.some((call) => call.args[1] === "rm")).toBe(false);
  });

  it("fails closed when volume inspection itself fails", async () => {
    const runner = new VolumeRunner(inspectResult("", 1, "daemon unavailable"));

    const ensure = ensureCiRunnerVolume(runner, projectPlan);

    await expect(ensure).rejects.toThrow(/failed to inspect CI runner volume/);
    expect(runner.calls).toHaveLength(1);
  });

  it("refuses a foreign volume created in an inspect-create race", async () => {
    const runner = new VolumeRunner([
      inspectResult("", 1, "No such volume"),
      inspectResult(volumeCases[4].values.map((value, index) => index === 1 ? "foreign" : value).join("|"))
    ]);

    const ensure = ensureCiRunnerVolume(runner, projectPlan);

    await expect(ensure).rejects.toThrow(/conflicts with DIM ownership/);
    expect(runner.calls).toHaveLength(3);
  });

  it("preserves a foreign same-name replacement detected immediately before deletion", async () => {
    const owned = volumeCases[4].values.join("|");
    const foreign = volumeCases[4].values.map((value, index) => index === 1 ? "foreign" : value).join("|");
    const runner = new VolumeRunner([inspectResult(owned), inspectResult(foreign)]);

    const remove = removeCiRunnerVolume(runner, projectPlan, testDescription(projectPlan));

    await expect(remove).rejects.toThrow(/conflicts with DIM ownership/);
    expect(runner.calls.some((call) => call.args[1] === "rm")).toBe(false);
  });
});

function labelValue(label: string): string {
  return label.slice(label.indexOf("=") + 1);
}

function testDescription(plan: CiRunnerVolumePlan): string {
  return `test ${plan.resource}`;
}
