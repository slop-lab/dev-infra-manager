import { expect, it } from "vitest";
import { ContainerWorkspaceRuntime, workspaceRuntimeResources, type CommandRunner, type WorkspaceRuntimeDevice } from "@slop-lab/dim-host-core/workspace";
import { workspaceRecord } from "../../support/workspaceFixture.js";

const device: WorkspaceRuntimeDevice = { hostPath: "/private/devices/node", containerPath: "/dev/test", major: 10, minor: 232, permissions: "rw" };
function fixture() {
  const record = workspaceRecord(), names = workspaceRuntimeResources(record);
  const value = { Id: "id", Config: { Image: record.image, Labels: { "dim.managed": "true", "dim.workspace-id": record.id, "dim.resource": "container", "dim.workspace-schema": "10" } },
    HostConfig: { Runtime: "sysbox-runc", Privileged: false, OomScoreAdj: 500, Devices: [], DeviceCgroupRules: ["c 10:232 rw"], NetworkMode: names.network }, State: { Running: true },
    Mounts: [...([["home", "/home/dim"], ["checkout", "/workspace"], ["docker", "/var/lib/docker"], ["tmp", "/mnt/dim-tmp"]] as const).map(([role, Destination]) => ({ Type: "volume", RW: true, Destination, Name: names[role], Source: "" })),
      { Type: "bind", RW: true, Destination: device.containerPath, Source: device.hostPath, Name: "" }], NetworkSettings: { Networks: { [names.network]: {} } } };
  const runner: CommandRunner & { runStreaming(): Promise<number> } = { async run(command, args) { return { command, args, exitCode: 0, stdout: JSON.stringify(value), stderr: "" }; }, async runStreaming() { return 0; } };
  return { record, value, runner };
}
it("accepts only the exact trusted char-device mount and cgroup grant; base runtime grants none", async () => {
  const { record, runner } = fixture();
  await expect(new ContainerWorkspaceRuntime(runner, runner, { devices: [device] }).inspect(record)).resolves.toEqual({ id: "id", running: true });
  await expect(new ContainerWorkspaceRuntime(runner).inspect(record)).rejects.toThrow(/conflicts/);
});
it.each(["source", "target", "mode", "rule", "extra-mount"])("rejects changed trusted device isolation: %s", async (change) => {
  const { record, runner, value } = fixture();
  const mount = value.Mounts.at(-1)!;
  if (change === "source") mount.Source = "/host/other";
  if (change === "target") mount.Destination = "/dev/other";
  if (change === "mode") mount.RW = false;
  if (change === "rule") value.HostConfig.DeviceCgroupRules = ["c 10:* rwm"];
  if (change === "extra-mount") value.Mounts.push({ ...mount, Destination: "/host" });
  await expect(new ContainerWorkspaceRuntime(runner, runner, { devices: [device] }).inspect(record)).rejects.toThrow(/conflicts|unexpected|changed/);
});
it("rejects malformed grants and duplicate targets before any runtime command", () => {
  const { runner } = fixture();
  expect(() => new ContainerWorkspaceRuntime(runner, runner, { devices: [{ ...device, hostPath: "/private/node,readonly" }] })).toThrow(/invalid/);
  expect(() => new ContainerWorkspaceRuntime(runner, runner, { devices: [{ ...device, major: -1 }] })).toThrow(/invalid/);
  expect(() => new ContainerWorkspaceRuntime(runner, runner, { devices: [device, device] })).toThrow(/duplicate/);
});
