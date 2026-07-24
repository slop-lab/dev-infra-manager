import { access, constants, readFile } from "node:fs/promises";
import { lifecycleOptions } from "./lifecycleOptions.js";
import type { LifecycleOptions, WorkspaceRuntimeBackendKind } from "./lifecycleTypes.js";
import { workspaceRuntimePlan } from "./runtimeBackends.js";
import type { CommandRunner } from "./types.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
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
  checks.push(await commandCheck(runner, "docker", ["--version"], "Docker CLI"));
  checks.push(await dockerDaemonCheck(runner));
  checks.push(...(await runtimeBackendChecks(runner, backend, options)));
  checks.push(await cgroupCheck());
  return checks;
}

async function runtimeBackendChecks(
  runner: CommandRunner,
  backend: WorkspaceRuntimeBackendKind,
  options: LifecycleOptions
): Promise<DoctorCheck[]> {
  const plan = workspaceRuntimePlan(backend, options);
  switch (backend) {
    case "sysbox": {
      return [
        await commandCheck(runner, "sysbox-runc", ["--version"], "sysbox-runc"),
        await systemdUnitCheck(runner, "sysbox.service", "Sysbox service"),
        await dockerRuntimeCheck(runner, plan.dockerRuntime, `Docker ${plan.dockerRuntime} runtime`),
        await dockerRuntimeExecutionCheck(runner, plan.dockerRuntime, "Sysbox container execution"),
        await pathCheck("/dev/kvm", "KVM device")
      ];
    }
    case "gvisor": {
      return [
        await commandCheck(runner, "runsc", ["--version"], "runsc"),
        await dockerRuntimeCheck(runner, plan.dockerRuntime, `Docker ${plan.dockerRuntime} runtime`),
        await dockerRuntimeExecutionCheck(runner, plan.dockerRuntime, "gVisor container execution")
      ];
    }
    case "rootless-podman":
      return [
        await dockerImageCheck(runner, plan.image, "Rootless Podman workspace image"),
        await dockerAgentCommandCheck(runner, plan.image, ["podman", "--version"], "Podman in workspace image"),
        await pathCheck("/dev/fuse", "FUSE device")
      ];
    case "runc":
      return [
        await dockerRuntimeCheck(runner, plan.dockerRuntime, `Docker ${plan.dockerRuntime} runtime`),
        await dockerRuntimeExecutionCheck(runner, plan.dockerRuntime, "runc container execution")
      ];
  }
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

async function pathCheck(path: string, name: string): Promise<DoctorCheck> {
  try {
    await access(path, constants.R_OK | constants.W_OK);
    return { name, ok: true, detail: path };
  } catch {
    return { name, ok: false, detail: `${path} is not accessible` };
  }
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

async function dockerRuntimeCheck(runner: CommandRunner, runtime: string, name: string): Promise<DoctorCheck> {
  let result = await runner.run("docker", ["info", "--format", "{{json .Runtimes}}"]);
  if (result.exitCode !== 0 && `${result.stderr}${result.stdout}`.includes("permission denied")) {
    result = await runner.run("docker", ["info", "--format", "{{json .Runtimes}}"], { sudo: true });
  }
  const output = `${result.stdout}${result.stderr}`;
  return {
    name,
    ok: result.exitCode === 0 && output.includes(`"${runtime}"`),
    detail: result.exitCode === 0 ? (output.includes(`"${runtime}"`) ? "registered" : "not registered") : "docker info failed"
  };
}

export async function dockerRuntimeExecutionCheck(runner: CommandRunner, runtime: string, name: string): Promise<DoctorCheck> {
  let result = await runner.run("docker", ["run", "--rm", `--runtime=${runtime}`, "--pull=missing", "hello-world:latest"]);
  if (result.exitCode !== 0 && `${result.stderr}${result.stdout}`.includes("permission denied")) {
    result = await runner.run("docker", ["run", "--rm", `--runtime=${runtime}`, "--pull=missing", "hello-world:latest"], { sudo: true });
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

async function dockerImageCheck(runner: CommandRunner, image: string, name: string): Promise<DoctorCheck> {
  let result = await runner.run("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);
  if (result.exitCode !== 0 && `${result.stderr}${result.stdout}`.includes("permission denied")) {
    result = await runner.run("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { sudo: true });
  }
  return {
    name,
    ok: result.exitCode === 0,
    detail: result.exitCode === 0 ? "present" : firstLine(`${result.stderr}${result.stdout}`) || "image not present"
  };
}

async function dockerAgentCommandCheck(runner: CommandRunner, image: string, commandArgs: string[], name: string): Promise<DoctorCheck> {
  let result = await runner.run("docker", ["run", "--rm", image, ...commandArgs]);
  if (result.exitCode !== 0 && `${result.stderr}${result.stdout}`.includes("permission denied")) {
    result = await runner.run("docker", ["run", "--rm", image, ...commandArgs], { sudo: true });
  }
  return {
    name,
    ok: result.exitCode === 0,
    detail: result.exitCode === 0 ? firstLine(`${result.stdout}${result.stderr}`) : firstLine(`${result.stderr}${result.stdout}`) || "agent command failed"
  };
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
