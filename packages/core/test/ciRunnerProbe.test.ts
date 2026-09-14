import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseCiRunnerConfigYaml } from "../../../../core/packages/core/src/ciRunnerConfig.js";
import { probeCiRunnerWorkloads } from "../../../../core/packages/core/src/ciRunnerProbe.js";
import { boundedCiRunnerResourceName } from "../../../../core/packages/core/src/ciRunnerVolume.js";
import { IMAGE, ProbeRunner, probeContainerName, probeSocketVolumeName } from "./ciRunnerProbeHarness.js";
const HOST_IMAGE_ID = `sha256:${"b".repeat(64)}`;
const PROJECT_ID = "project-id";
const config = parseCiRunnerConfigYaml(`schemaVersion: 1
workloads:
  ordinary:
    labels: [dim]
    image: ${IMAGE}
    tools: [bash, git]
    capabilities: []
  integration:
    labels: [dim-container-integration]
    image: ${IMAGE}
    tools: [bash, docker]
    capabilities: [nested-docker]
`);

function probeLabels(name: string, resource: string, kind: string): readonly string[] {
  const fields = [name, "project", PROJECT_ID, "primary", "sysbox", resource, kind];
  const hash = createHash("sha256");
  for (const field of fields) hash.update(`${Buffer.byteLength(field)}:${field};`);
  return [
    "dim.managed=true",
    "dim.owner=dim",
    "dim.project=project",
    `dim.project-id=${PROJECT_ID}`,
    "dim.capacity=primary",
    "dim.executor=sysbox",
    `dim.resource=${resource}`,
    `dim.kind=${kind}`,
    `dim.digest=${hash.digest("hex")}`
  ];
}

function probeInput() {
  return {
    config,
    hostImage: HOST_IMAGE_ID,
    runtime: "sysbox-runc",
    projectName: "project",
    projectId: PROJECT_ID,
    capacityName: "primary",
    executorKind: "sysbox" as const
  };
}

describe("CI workload probes", () => {
  it("runs declared tools and capabilities only through an isolated nested daemon", async () => {
    const runner = new ProbeRunner();

    await probeCiRunnerWorkloads(runner, probeInput());

    expect(runner.calls.every((call) => call[0] === "docker")).toBe(true);
    const probes = runner.calls.filter((call) => call.includes(IMAGE));
    expect(probes).toHaveLength(2);
    expect(probes.every((call) => call.includes("always") && call.includes(IMAGE))).toBe(true);
    expect(probes.filter((call) => call.join(" ").includes("/var/run/docker.sock"))).toHaveLength(1);
    expect(runner.calls.some((call) => call.includes(probeSocketVolumeName()))).toBe(true);
    expect(runner.volumes.has(probeSocketVolumeName())).toBe(false);
  });

  it("fails before registration when a declared tool probe fails", async () => {
    const runner = new ProbeRunner();
    runner.failToolProbe = true;

    await expect(probeCiRunnerWorkloads(runner, probeInput()))
      .rejects.toThrow(/configured CI workload probe failed.*missing tool/);

    expect(runner.volumes.has(probeSocketVolumeName())).toBe(false);
  });

  it("rejects a mutable trusted host image before starting a probe container", async () => {
    const runner = new ProbeRunner();

    await expect(probeCiRunnerWorkloads(runner, { ...probeInput(), hostImage: "dim-runner-host:test" }))
      .rejects.toThrow(/host image.*Docker image ID/i);

    expect(runner.calls).toEqual([]);
  });

  it("bounds container and socket names independently from their complete identity", async () => {
    const runner = new ProbeRunner();
    const projectName = "p".repeat(48);
    const capacityName = "c".repeat(48);

    await probeCiRunnerWorkloads(runner, { ...probeInput(), projectName, capacityName, executorKind: "qemu" });

    const containerName = runner.calls.find((call) => call.includes("--detach"))?.[4];
    const socketVolume = runner.calls.find((call) => call[1] === "volume" && call[2] === "create")?.at(-1);
    expect(containerName).toBe(boundedCiRunnerResourceName([
      "dim", "ci", projectName, capacityName, "qemu", "workload-probe"
    ]));
    expect(socketVolume).toBe(boundedCiRunnerResourceName([
      "dim", "ci", projectName, capacityName, "qemu", "workload-probe-socket"
    ]));
    expect(containerName?.length).toBeLessThanOrEqual(63);
    expect(socketVolume?.length).toBeLessThanOrEqual(63);
    expect(socketVolume).not.toBe(`${containerName}-socket`);
  });

  it("keeps long probe resource names distinct when identity differs beyond their common prefix", async () => {
    const projectName = "p".repeat(48);
    const firstCapacityName = `${"c".repeat(47)}a`;
    const secondCapacityName = `${"c".repeat(47)}b`;
    const firstRunner = new ProbeRunner();
    const secondRunner = new ProbeRunner();

    await probeCiRunnerWorkloads(firstRunner, { ...probeInput(), projectName, capacityName: firstCapacityName });
    await probeCiRunnerWorkloads(secondRunner, { ...probeInput(), projectName, capacityName: secondCapacityName });

    const firstContainer = firstRunner.calls.find((call) => call.includes("--detach"))?.[4];
    const secondContainer = secondRunner.calls.find((call) => call.includes("--detach"))?.[4];
    const firstSocket = firstRunner.calls.find((call) => call[1] === "volume" && call[2] === "create")?.at(-1);
    const secondSocket = secondRunner.calls.find((call) => call[1] === "volume" && call[2] === "create")?.at(-1);
    expect(firstContainer).not.toBe(secondContainer);
    expect(firstSocket).not.toBe(secondSocket);
  });

  it("leaves a foreign same-name probe container untouched", async () => {
    const runner = new ProbeRunner();
    const foreignLabels = ["dim.managed=true", "dim.owner=foreign"];
    runner.containers.set(probeContainerName(), foreignLabels);

    const probe = probeCiRunnerWorkloads(runner, probeInput());

    await expect(probe).rejects.toThrow(/container.*conflicts with DIM ownership/i);
    expect(runner.containers.get(probeContainerName())).toEqual(foreignLabels);
    expect(runner.calls.some((call) => call[1] === "container" && call[2] === "rm")).toBe(false);
  });

  it("leaves a foreign same-name probe volume untouched", async () => {
    const runner = new ProbeRunner();
    const foreignLabels = ["dim.managed=true", "dim.owner=foreign"];
    runner.volumes.set(probeSocketVolumeName(), foreignLabels);

    const probe = probeCiRunnerWorkloads(runner, probeInput());

    await expect(probe).rejects.toThrow(/volume.*conflicts with DIM ownership/i);
    expect(runner.volumes.get(probeSocketVolumeName())).toEqual(foreignLabels);
    expect(runner.calls.some((call) => call[1] === "volume" && call[2] === "rm")).toBe(false);
  });

  it("settles every ownership conflict before reporting the first resource plan failure", async () => {
    const runner = new ProbeRunner();
    const foreignContainerLabels = ["dim.managed=true", "dim.owner=foreign-container"];
    const foreignVolumeLabels = ["dim.managed=true", "dim.owner=foreign-volume"];
    runner.containers.set(probeContainerName(), foreignContainerLabels);
    runner.volumes.set(probeSocketVolumeName(), foreignVolumeLabels);

    const probe = probeCiRunnerWorkloads(runner, probeInput());

    await expect(probe).rejects.toThrow(/container.*conflicts with DIM ownership/i);
    expect(runner.containers.get(probeContainerName())).toEqual(foreignContainerLabels);
    expect(runner.volumes.get(probeSocketVolumeName())).toEqual(foreignVolumeLabels);
    expect(runner.calls.some((call) => call[2] === "rm")).toBe(false);
  });

  it("removes exact owned residue and labels its replacement completely", async () => {
    const runner = new ProbeRunner();
    runner.containers.set(probeContainerName(), probeLabels(probeContainerName(), "ci-workload-probe", "container"));
    runner.volumes.set(probeSocketVolumeName(), probeLabels(probeSocketVolumeName(), "ci-workload-probe-socket", "volume"));

    await probeCiRunnerWorkloads(runner, probeInput());

    expect(runner.calls.filter((call) => call[1] === "container" && call[2] === "rm")).toHaveLength(2);
    expect(runner.calls.filter((call) => call[1] === "volume" && call[2] === "rm")).toHaveLength(2);
    expect(runner.calls.find((call) => call[1] === "volume" && call[2] === "create")).toEqual([
      "docker", "volume", "create",
      ...probeLabels(probeSocketVolumeName(), "ci-workload-probe-socket", "volume").flatMap((label) => ["--label", label]),
      probeSocketVolumeName()
    ]);
    expect(runner.calls.find((call) => call.includes("--detach"))).toEqual(expect.arrayContaining(
      probeLabels(probeContainerName(), "ci-workload-probe", "container").flatMap((label) => ["--label", label])
    ));
    expect(runner.containers.has(probeContainerName())).toBe(false);
    expect(runner.volumes.has(probeSocketVolumeName())).toBe(false);
  });

  it("waits for attached probe containers to be removed before removing their volumes", async () => {
    const runner = new ProbeRunner();
    runner.deferContainerRemoval = true;
    runner.containers.set(probeContainerName(), probeLabels(probeContainerName(), "ci-workload-probe", "container"));
    runner.volumes.set(probeSocketVolumeName(), probeLabels(probeSocketVolumeName(), "ci-workload-probe-socket", "volume"));
    runner.containerVolumes.set(probeContainerName(), [probeSocketVolumeName()]);

    const probe = probeCiRunnerWorkloads(runner, probeInput());
    await runner.containerRemovalStarted.wait;
    const volumeRemovalStarted = runner.calls.some((call) => call[1] === "volume" && call[2] === "rm");
    runner.containerRemovalReleased.open();

    await expect(probe).resolves.toBeUndefined();
    expect(volumeRemovalStarted).toBe(false);
    expect(runner.volumes.has(probeSocketVolumeName())).toBe(false);
  });

  it("leaves a foreign same-name volume untouched when it wins the creation race", async () => {
    const runner = new ProbeRunner();
    const foreignLabels = ["dim.managed=true", "dim.owner=foreign"];
    runner.volumeCreateRaceLabels = foreignLabels;

    const probe = probeCiRunnerWorkloads(runner, probeInput());

    await expect(probe).rejects.toThrow(/volume.*conflicts with DIM ownership/i);
    expect(runner.volumes.get(probeSocketVolumeName())).toEqual(foreignLabels);
    expect(runner.calls.some((call) => call[1] === "volume" && call[2] === "rm")).toBe(false);
  });

  it("leaves a foreign replacement intact when final cleanup re-inspects ownership", async () => {
    const runner = new ProbeRunner();
    runner.replaceContainerDuringProbe = true;

    const probe = probeCiRunnerWorkloads(runner, probeInput());

    await expect(probe).rejects.toThrow(/container.*conflicts with DIM ownership/i);
    expect(runner.containers.get(probeContainerName())).toEqual(["dim.managed=true", "dim.owner=foreign"]);
    expect(runner.volumes.has(probeSocketVolumeName())).toBe(false);
  });

  it("removes a probe container by inspected ID when its name is replaced", async () => {
    const runner = new ProbeRunner();
    runner.replaceContainerAfterCleanupInspect = true;

    await probeCiRunnerWorkloads(runner, probeInput());

    expect(runner.containers.get(probeContainerName())).toEqual(["dim.managed=true", "dim.owner=foreign"]);
    expect(runner.calls.some((call) => call[2] === "rm" && call.at(-1) === `container-id:${probeContainerName()}`)).toBe(true);
    expect(runner.calls.some((call) => call.at(-1) === `foreign-id:${probeContainerName()}`)).toBe(false);
  });

  it("preserves a foreign probe volume replacement detected by deletion reinspection", async () => {
    const runner = new ProbeRunner();
    runner.replaceVolumeAfterCleanupInspect = true;

    const probe = probeCiRunnerWorkloads(runner, probeInput());

    await expect(probe).rejects.toThrow(/volume.*conflicts with DIM ownership/i);
    expect(runner.volumes.get(probeSocketVolumeName())).toEqual(["dim.managed=true", "dim.owner=foreign"]);
    expect(runner.calls.some((call) => call[1] === "volume" && call[2] === "rm")).toBe(false);
  });
});
