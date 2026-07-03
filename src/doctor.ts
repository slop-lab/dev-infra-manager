import { access, constants, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "./types.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(runner: CommandRunner): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push(await commandCheck(runner, "node", ["--version"], "Node.js"));
  checks.push(await commandCheck(runner, "pnpm", ["--version"], "pnpm"));
  checks.push(await commandCheck(runner, "just", ["--version"], "just"));
  checks.push(await commandCheck(runner, "git", ["--version"], "git"));
  checks.push(await commandCheck(runner, "timeout", ["--version"], "timeout"));
  checks.push(await commandCheck(runner, "docker", ["--version"], "Docker CLI"));
  checks.push(await dockerDaemonCheck(runner));
  checks.push(await commandCheck(runner, "sysbox-runc", ["--version"], "sysbox-runc"));
  checks.push(await systemdUnitCheck(runner, "sysbox.service", "Sysbox service"));
  checks.push(await dockerRuntimeCheck(runner, "sysbox-runc", "Docker sysbox-runc runtime"));
  checks.push(await loopDeviceCheck(runner));
  checks.push(await pathCheck("/dev/kvm", "KVM device"));
  checks.push(await cgroupCheck());
  return checks;
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
