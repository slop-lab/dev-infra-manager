import { describe, expect, it } from "vitest";
import { classifyProjectRuntimeCgroups, inspectProjectRuntimeCgroups } from "../../../../core/packages/core/src/projectRuntimeCgroups.js";

describe("project runtime cgroups", () => {
  it.each(["systemd", "cgroupfs"])("accepts writable cgroup v2 delegation with the %s driver", (driver) => {
    expect(classifyProjectRuntimeCgroups({
      driver,
      filesystem: "cgroup2fs",
      writable: true,
      controllers: ["pids", "memory", "cpu", "pids"]
    })).toEqual({
      version: 1,
      status: "delegated",
      driver,
      path: "/sys/fs/cgroup",
      controllers: ["cpu", "memory", "pids"]
    });
  });

  it("reports unsupported and incomplete boundaries without compatibility fallbacks", () => {
    expect(classifyProjectRuntimeCgroups({
      driver: "none", filesystem: "cgroup2fs", writable: true, controllers: ["pids"]
    })).toMatchObject({ status: "unavailable", driver: "none", reason: expect.stringContaining("driver 'none'") });
    expect(classifyProjectRuntimeCgroups({
      driver: "systemd", filesystem: "cgroup2fs", writable: false, controllers: ["pids"]
    })).toMatchObject({ status: "unavailable", reason: expect.stringContaining("read-only") });
    expect(classifyProjectRuntimeCgroups({
      driver: "cgroupfs", filesystem: "cgroup2fs", writable: true, controllers: ["cpu"]
    })).toMatchObject({ status: "unavailable", reason: expect.stringContaining("pids") });
  });

  it("inspects the nested engine and workspace cgroup namespace", async () => {
    const calls: string[][] = [];
    const plan = await inspectProjectRuntimeCgroups({
      run: async (_command, args) => {
        calls.push(args);
        return { command: "docker", args, stdout: "systemd\ncgroup2fs\nyes\ncpu memory pids\n", stderr: "", exitCode: 0 };
      }
    }, "dim-ws-example", "docker");
    expect(plan).toMatchObject({ status: "delegated", driver: "systemd" });
    expect(calls[0]).toEqual(expect.arrayContaining(["exec", "--user", "root", "dim-ws-example"]));
    expect(calls[0]?.at(-1)).toContain("docker info --format '{{.CgroupDriver}}'");
  });
});
