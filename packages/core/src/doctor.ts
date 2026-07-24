import { access, constants, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, normalizeConfig } from "./config.js";
import type { CommandRunner, DevInfraConfig } from "./types.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(runner: CommandRunner, config: DevInfraConfig = normalizeConfig(DEFAULT_CONFIG)): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push(await commandCheck(runner, "node", ["--version"], "Node.js"));
  checks.push(await commandCheck(runner, "pnpm", ["--version"], "pnpm"));
  checks.push(await commandCheck(runner, "just", ["--version"], "just"));
  checks.push(await commandCheck(runner, "git", ["--version"], "git"));
  checks.push(await commandCheck(runner, "timeout", ["--version"], "timeout"));
  checks.push(await commandCheck(runner, "docker", ["--version"], "Docker CLI"));
  checks.push(await dockerDaemonCheck(runner));
  checks.push(...(await runtimeBackendChecks(runner, config)));
  checks.push(...(await storageBackendChecks(runner, config)));
  checks.push(await cgroupCheck());
  return checks;
}

async function runtimeBackendChecks(runner: CommandRunner, config: DevInfraConfig): Promise<DoctorCheck[]> {
  switch (config.agent.runtimeBackend.kind) {
    case "sysbox": {
      const runtime = config.agent.runtimeBackend.dockerRuntime ?? "sysbox-runc";
      return [
        await commandCheck(runner, "sysbox-runc", ["--version"], "sysbox-runc"),
        await systemdUnitCheck(runner, "sysbox.service", "Sysbox service"),
        await dockerRuntimeCheck(runner, runtime, `Docker ${runtime} runtime`),
        await dockerRuntimeExecutionCheck(runner, runtime, "Sysbox container execution"),
        await pathCheck("/dev/kvm", "KVM device")
      ];
    }
    case "gvisor": {
      const runtime = config.agent.runtimeBackend.dockerRuntime ?? "runsc";
      return [
        await commandCheck(runner, "runsc", ["--version"], "runsc"),
        await dockerRuntimeCheck(runner, runtime, `Docker ${runtime} runtime`),
        await dockerRuntimeExecutionCheck(runner, runtime, "gVisor container execution")
      ];
    }
    case "rootless-podman":
      return [
        await dockerImageCheck(runner, config.agent.image, "Rootless Podman agent image"),
        await dockerAgentCommandCheck(runner, config.agent.image, ["podman", "--version"], "Podman in agent image"),
        await pathCheck("/dev/fuse", "FUSE device")
      ];
  }
}

async function storageBackendChecks(runner: CommandRunner, config: DevInfraConfig): Promise<DoctorCheck[]> {
  switch (config.storageBackend.kind) {
    case "loopback":
      return [await loopDeviceCheck(runner)];
    case "directory":
      return [{ name: "Directory storage backend", ok: true, detail: "available; diskBytes is not enforced by this backend" }];
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

async function loopDeviceCheck(runner: CommandRunner): Promise<DoctorCheck> {
  const dir = await mkdtemp(join(tmpdir(), "dim-loop-check-"));
  const image = join(dir, "disk.img");
  let loopDevice = "";
  try {
    let result = await runner.run("truncate", ["-s", "8M", image]);
    if (result.exitCode !== 0) {
      return { name: "Loop device setup", ok: false, detail: "failed to create test image" };
    }

    result = await runner.run("losetup", ["-f", "--show", image], { sudo: true });
    loopDevice = result.stdout.trim();
    return {
      name: "Loop device setup",
      ok: result.exitCode === 0,
      detail: result.exitCode === 0 ? loopDevice : `${result.stderr}${result.stdout}`.trim()
    };
  } finally {
    if (loopDevice) {
      await runner.run("losetup", ["-d", loopDevice], { sudo: true });
    }
    await rm(dir, { recursive: true, force: true });
  }
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
