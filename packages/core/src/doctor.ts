import { readFile } from "node:fs/promises";
import { lifecycleOptions, lifecycleOptionsForBackend } from "./lifecycleOptions.js";
import type { LifecycleOptions, WorkspaceRuntimeBackendKind } from "./lifecycleTypes.js";
import { workspaceRuntimePlan } from "./runtimeBackends.js";
import type { CommandRunner } from "./types.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface WorkspaceBackendInspection {
  backend: WorkspaceRuntimeBackendKind;
  ok: boolean;
  checks: DoctorCheck[];
}

export async function runDoctor(
  runner: CommandRunner,
  backend: WorkspaceRuntimeBackendKind = lifecycleOptions().defaultWorkspaceBackend,
  options: LifecycleOptions = lifecycleOptions()
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push(await commandCheck(runner, "node", ["--version"], "Node.js"));
  checks.push(await commandCheck(runner, "pnpm", ["--version"], "pnpm"));
  checks.push(await commandCheck(runner, "just", ["--version"], "just"));
  checks.push(await commandCheck(runner, "git", ["--version"], "git"));
  checks.push(await commandCheck(runner, "script", ["--version"], "PTY helper"));
  checks.push(await commandCheck(runner, "stty", ["--version"], "terminal resize helper"));
  checks.push(await userSystemdCheck(runner));
  checks.push(await userLingerCheck(runner));
  checks.push(await appArmorUserNamespaceCheck(runner));
  checks.push(await commandCheck(runner, "docker", ["--version"], "Docker CLI"));
  checks.push(await dockerDaemonCheck(runner));
  checks.push(...(await runtimeBackendChecks(runner, backend, options)));
  checks.push(await cgroupCheck());
  return checks;
}

export async function inspectWorkspaceBackends(
  runner: CommandRunner,
  env: NodeJS.ProcessEnv = process.env
): Promise<WorkspaceBackendInspection[]> {
  const backends: WorkspaceRuntimeBackendKind[] = ["sysbox"];
  const inspections: WorkspaceBackendInspection[] = [];
  for (const backend of backends) {
    const checks = await runtimeBackendChecks(runner, backend, lifecycleOptionsForBackend(backend, env));
    inspections.push({
      backend,
      checks,
      ok: checks.every((check) => check.ok)
    });
  }
  return inspections;
}

export async function runCommonDoctorChecks(runner: CommandRunner): Promise<DoctorCheck[]> {
  return [
    await commandCheck(runner, "node", ["--version"], "Node.js"),
    await commandCheck(runner, "pnpm", ["--version"], "pnpm"),
    await commandCheck(runner, "just", ["--version"], "just"),
    await commandCheck(runner, "git", ["--version"], "git"),
    await commandCheck(runner, "script", ["--version"], "PTY helper"),
    await commandCheck(runner, "stty", ["--version"], "terminal resize helper"),
    await userSystemdCheck(runner),
    await userLingerCheck(runner),
    await appArmorUserNamespaceCheck(runner),
    await commandCheck(runner, "docker", ["--version"], "Docker CLI"),
    await dockerDaemonCheck(runner),
    await cgroupCheck()
  ];
}

export async function runtimeBackendChecks(
  runner: CommandRunner,
  backend: WorkspaceRuntimeBackendKind,
  options: LifecycleOptions
): Promise<DoctorCheck[]> {
  workspaceRuntimePlan(backend, options);
  return [
    await commandCheck(runner, "sysbox-runc", ["--version"], "sysbox-runc"),
    await systemdUnitCheck(runner, "sysbox.service", "Sysbox service"),
    await dockerRuntimeCheck(runner, "sysbox-runc", "Docker sysbox-runc runtime"),
    await dockerRuntimeExecutionCheck(runner, "sysbox-runc", "Sysbox container execution")
  ];
}

async function commandCheck(runner: CommandRunner, command: string, args: string[], name: string): Promise<DoctorCheck> {
  const result = await runner.run(command, args);
  const output = `${result.stdout}${result.stderr}`.trim().split("\n")[0] ?? "";
  return {
    name,
    ok: result.exitCode === 0,
    detail: result.exitCode === 0 ? output : `${command} not available`
  };
}

async function dockerDaemonCheck(runner: CommandRunner): Promise<DoctorCheck> {
  let result = await runner.run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (result.exitCode !== 0 && `${result.stderr}${result.stdout}`.includes("permission denied")) {
    result = await runner.run("docker", ["info", "--format", "{{.ServerVersion}}"], { sudo: true });
  }
  const detail = `${result.stdout}${result.stderr}`.trim().split("\n")[0] ?? "";
  return {
    name: "Docker daemon",
    ok: result.exitCode === 0,
    detail: result.exitCode === 0 ? detail : "docker daemon is not reachable"
  };
}

async function dockerRuntimeCheck(runner: CommandRunner, runtime: string, name: string, socket?: string): Promise<DoctorCheck> {
  const prefix = socket ? ["--host", `unix://${socket}`] : [];
  let result = await runner.run("docker", [...prefix, "info", "--format", "{{json .Runtimes}}"]);
  if (result.exitCode !== 0 && `${result.stderr}${result.stdout}`.includes("permission denied")) {
    result = await runner.run("docker", [...prefix, "info", "--format", "{{json .Runtimes}}"], { sudo: true });
  }
  const output = `${result.stdout}${result.stderr}`;
  return {
    name,
    ok: result.exitCode === 0 && output.includes(`"${runtime}"`),
    detail: result.exitCode === 0 ? (output.includes(`"${runtime}"`) ? "registered" : "not registered") : "docker info failed"
  };
}

export async function dockerRuntimeExecutionCheck(runner: CommandRunner, runtime: string, name: string, socket?: string): Promise<DoctorCheck> {
  const prefix = socket ? ["--host", `unix://${socket}`] : [];
  let result = await runner.run("docker", [...prefix, "run", "--rm", `--runtime=${runtime}`, "--pull=missing", "hello-world:latest"]);
  if (result.exitCode !== 0 && `${result.stderr}${result.stdout}`.includes("permission denied")) {
    result = await runner.run("docker", [...prefix, "run", "--rm", `--runtime=${runtime}`, "--pull=missing", "hello-world:latest"], { sudo: true });
  }
  const output = `${result.stderr}${result.stdout}`.trim();
  return {
    name,
    ok: result.exitCode === 0,
    detail: result.exitCode === 0 ? "hello-world completed" : firstLine(output) || "docker run failed"
  };
}

export async function sysboxExecutionCheck(runner: CommandRunner): Promise<DoctorCheck> {
  return dockerRuntimeExecutionCheck(runner, "sysbox-runc", "Sysbox container execution");
}

async function systemdUnitCheck(runner: CommandRunner, unit: string, name: string): Promise<DoctorCheck> {
  const result = await runner.run("systemctl", ["is-active", unit]);
  const detail = `${result.stdout}${result.stderr}`.trim();
  return {
    name,
    ok: result.exitCode === 0 && detail === "active",
    detail: detail || "inactive"
  };
}

async function userSystemdCheck(runner: CommandRunner): Promise<DoctorCheck> {
  const result = await runner.run("systemctl", ["--user", "show-environment"]);
  return {
    name: "systemd user manager",
    ok: result.exitCode === 0,
    detail: result.exitCode === 0
      ? "available"
      : firstLine(`${result.stderr}${result.stdout}`) || "not available"
  };
}

export async function userLingerCheck(
  runner: CommandRunner,
  user: string = String(process.getuid?.() ?? "self")
): Promise<DoctorCheck> {
  const result = await runner.run("loginctl", ["show-user", user, "--property=Linger", "--value"]);
  const enabled = result.exitCode === 0 && result.stdout.trim() === "yes";
  return {
    name: "systemd user linger",
    ok: enabled,
    detail: enabled
      ? "enabled"
      : result.exitCode === 0
        ? "disabled; run: sudo loginctl enable-linger $USER"
        : `${firstLine(`${result.stderr}${result.stdout}`) || "unable to query"}; run: sudo loginctl enable-linger $USER`
  };
}

export async function appArmorUserNamespaceCheck(runner: CommandRunner): Promise<DoctorCheck> {
  const restriction = await runner.run("sysctl", ["-n", "kernel.apparmor_restrict_unprivileged_userns"]);
  if (restriction.exitCode !== 0) {
    const detail = firstLine(`${restriction.stderr}${restriction.stdout}`);
    if (detail.includes("cannot stat /proc/sys/kernel/apparmor_restrict_unprivileged_userns")) {
      return {
        name: "AppArmor unprivileged user namespaces",
        ok: true,
        detail: "restriction not applicable"
      };
    }
    return {
      name: "AppArmor unprivileged user namespaces",
      ok: false,
      detail: detail || "unable to inspect restriction"
    };
  }
  if (restriction.stdout.trim() === "0") {
    return {
      name: "AppArmor unprivileged user namespaces",
      ok: true,
      detail: "restriction disabled"
    };
  }
  if (restriction.stdout.trim() !== "1") {
    return {
      name: "AppArmor unprivileged user namespaces",
      ok: false,
      detail: `unexpected restriction value: ${restriction.stdout.trim() || "empty"}`
    };
  }

  const profiles = await runner.run("cat", ["/sys/kernel/security/apparmor/profiles"], { sudo: true });
  const profileLoaded = profiles.exitCode === 0
    && profiles.stdout.split("\n").some((line) => line.startsWith("/usr/local/bin/rootlesskit "));
  return {
    name: "AppArmor unprivileged user namespaces",
    ok: profileLoaded,
    detail: profileLoaded
      ? "restriction enabled; rootlesskit profile loaded"
      : "restriction enabled; /usr/local/bin/rootlesskit profile is not loaded; run: sudo bash verification/scripts/install-rootlesskit-apparmor-profile-ubuntu.bash"
  };
}

async function cgroupCheck(): Promise<DoctorCheck> {
  try {
    const content = await readFile("/proc/filesystems", "utf8");
    const ok = content.includes("cgroup2");
    return { name: "cgroup v2", ok, detail: ok ? "available" : "not listed in /proc/filesystems" };
  } catch (error) {
    return { name: "cgroup v2", ok: false, detail: (error as Error).message };
  }
}

function firstLine(value: string): string {
  return value.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}
