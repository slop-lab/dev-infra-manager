import { UserError } from "./errors.js";
import type { CommandRunner } from "./types.js";

export type ProjectRuntimeCgroupDriver = "systemd" | "cgroupfs" | "none" | "unknown";

export interface ProjectRuntimeCgroups {
  version: 1;
  status: "delegated" | "unavailable";
  driver: ProjectRuntimeCgroupDriver;
  path?: "/sys/fs/cgroup";
  controllers: string[];
  reason?: string;
}

export function classifyProjectRuntimeCgroups(input: {
  driver: string;
  filesystem: string;
  writable: boolean;
  controllers: string[];
}): ProjectRuntimeCgroups {
  const driver = normalizeDriver(input.driver);
  const controllers = [...new Set(input.controllers)].sort();
  if (input.filesystem !== "cgroup2fs") {
    return unavailable(driver, controllers, "project runtime cgroups require cgroup v2");
  }
  if (driver === "none") {
    return unavailable(driver, controllers, "the nested container engine reports cgroup driver 'none'");
  }
  if (driver === "unknown") {
    return unavailable(driver, controllers, `unsupported nested container-engine cgroup driver '${input.driver || "unknown"}'`);
  }
  if (!input.writable) {
    return unavailable(driver, controllers, "the workspace cgroup namespace root is read-only");
  }
  if (!controllers.includes("pids")) {
    return unavailable(driver, controllers, "the delegated subtree does not expose the required pids controller");
  }
  return {
    version: 1,
    status: "delegated",
    driver,
    path: "/sys/fs/cgroup",
    controllers
  };
}

export async function inspectProjectRuntimeCgroups(
  runner: CommandRunner,
  containerName: string,
  engine: "docker"
): Promise<ProjectRuntimeCgroups> {
  const driverFormat = "{{.CgroupDriver}}";
  const result = await runner.run("docker", [
    "exec", "--user", "root", containerName, "sh", "-c",
    [
      `driver=$(${engine} info --format '${driverFormat}' 2>/dev/null || true)`,
      "filesystem=$(stat -fc %T /sys/fs/cgroup 2>/dev/null || true)",
      "if test -w /sys/fs/cgroup/cgroup.subtree_control; then writable=yes; else writable=no; fi",
      "controllers=$(cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null || true)",
      "printf '%s\\n%s\\n%s\\n%s\\n' \"$driver\" \"$filesystem\" \"$writable\" \"$controllers\""
    ].join("; ")
  ]);
  if (result.exitCode !== 0) {
    throw new UserError(`failed to inspect project runtime cgroups: ${result.stderr.trim()}`);
  }
  const [driver = "", filesystem = "", writable = "no", controllers = ""] = result.stdout.split("\n");
  return classifyProjectRuntimeCgroups({
    driver,
    filesystem,
    writable: writable === "yes",
    controllers: controllers.trim().split(/\s+/).filter(Boolean)
  });
}

function normalizeDriver(driver: string): ProjectRuntimeCgroupDriver {
  if (driver === "systemd" || driver === "cgroupfs" || driver === "none") return driver;
  return "unknown";
}

function unavailable(
  driver: ProjectRuntimeCgroupDriver,
  controllers: string[],
  reason: string
): ProjectRuntimeCgroups {
  return { version: 1, status: "unavailable", driver, controllers, reason };
}
