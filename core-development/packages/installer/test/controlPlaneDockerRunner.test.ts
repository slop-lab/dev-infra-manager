import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlPlaneDockerExecutionError,
  ControlPlaneDockerUncertainError,
  ProcessControlPlaneDockerRunner
} from "../../../../core/packages/installer/src/controlPlaneDocker.js";
import {
  dockerExecutableTrustFailure,
  dockerParentTrustFailure
} from "../../../../core/packages/installer/src/trustedDockerExecutable.js";

const temporaryDirectories: string[] = [];
const descendantPids: number[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const pid of descendantPids.splice(0)) {
    try { process.kill(pid, "SIGKILL"); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("control-plane Docker process runner", () => {
  it("ignores an untrusted Docker executable earlier on caller PATH", async () => {
    // Given
    const directory = await mkdtemp(join(tmpdir(), "dim-installer-hostile-path-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "selected");
    await writeFile(join(directory, "docker"), `#!/bin/sh\n: > '${marker}'\nexit 97\n`, { mode: 0o700 });
    vi.stubEnv("PATH", `${directory}:${process.env.PATH ?? ""}`);
    const runner = new ProcessControlPlaneDockerRunner();

    // When
    const result = await runner.run({ args: ["--version"], timeoutMilliseconds: 1_000, maximumOutputBytes: 1_024 });

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^Docker version /);
    await expect(access(marker)).rejects.toThrow();
  });

  it("uses a trusted child PATH while retaining Docker daemon selection", async () => {
    // Given
    const runner = new ProcessControlPlaneDockerRunner(await fakeDocker());
    vi.stubEnv("PATH", "/untrusted/project/bin");
    vi.stubEnv("DOCKER_HOST", "unix:///run/user/1000/docker.sock");

    // When
    const result = await runner.run({ args: ["environment"], timeoutMilliseconds: 1_000, maximumOutputBytes: 1_024 });

    // Then
    expect(JSON.parse(result.stdout)).toEqual({
      dockerHost: "unix:///run/user/1000/docker.sock",
      path: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    });
  });

  it("passes arguments without a shell and captures bounded output", async () => {
    // Given
    const executable = await fakeDocker();
    const runner = new ProcessControlPlaneDockerRunner(executable);

    // When
    const result = await runner.run({ args: ["record", "value with spaces", "$(false)"], timeoutMilliseconds: 1_000, maximumOutputBytes: 1_024 });

    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "[\"value with spaces\",\"$(false)\"]", stderr: "" });
  });

  it("terminates commands that exceed the output bound", async () => {
    // Given
    const runner = new ProcessControlPlaneDockerRunner(await fakeDocker());

    // When
    const action = runner.run({ args: ["output"], timeoutMilliseconds: 1_000, maximumOutputBytes: 32 });

    // Then
    await expect(action).rejects.toThrow(ControlPlaneDockerExecutionError);
  });

  it("terminates commands that exceed the time bound", async () => {
    // Given
    const runner = new ProcessControlPlaneDockerRunner(await fakeDocker());

    // When
    const action = runner.run({ args: ["wait"], timeoutMilliseconds: 20, maximumOutputBytes: 1_024 });

    // Then
    await expect(action).rejects.toThrow(/timed out/);
  });

  it("does not return while an escaped signal-ignoring descendant remains alive", async () => {
    // Given: a timed-out command whose detached descendant ignores TERM and does not hold the leader's stdio.
    const executable = await fakeDocker();
    const pidFile = `${executable}.descendant.pid`;
    const runner = new ProcessControlPlaneDockerRunner(executable);

    // When: the process tree exceeds its deadline.
    const action = runner.run({ args: ["wait-tree", pidFile], timeoutMilliseconds: 100, maximumOutputBytes: 1_024 });
    const error = await action.then(() => undefined, (reason: unknown) => reason);
    const descendantPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    descendantPids.push(descendantPid);

    // Then: settlement either reaps the exact descendant or reports a distinct uncertain incident.
    if (processExists(descendantPid)) expect(error).toBeInstanceOf(ControlPlaneDockerUncertainError);
    else expect(error).toBeInstanceOf(ControlPlaneDockerExecutionError);
  });
});

describe("trusted Docker executable policy", () => {
  it("rejects unsafe executable metadata", () => {
    // Given / When / Then
    expect(dockerExecutableTrustFailure({ kind: "directory", uid: 0, mode: 0o755 })).toBe("nonregular");
    expect(dockerExecutableTrustFailure({ kind: "file", uid: 1000, mode: 0o755 })).toBe("foreign-owned");
    expect(dockerExecutableTrustFailure({ kind: "file", uid: 0, mode: 0o775 })).toBe("writable");
    expect(dockerExecutableTrustFailure({ kind: "file", uid: 0, mode: 0o644 })).toBe("nonexecutable");
    expect(dockerExecutableTrustFailure({ kind: "file", uid: 0, mode: 0o755 })).toBeUndefined();
  });

  it("rejects unsafe parent metadata", () => {
    // Given / When / Then
    expect(dockerParentTrustFailure({ kind: "file", uid: 0, mode: 0o755 })).toBe("nondirectory");
    expect(dockerParentTrustFailure({ kind: "directory", uid: 1000, mode: 0o755 })).toBe("foreign-owned");
    expect(dockerParentTrustFailure({ kind: "directory", uid: 0, mode: 0o777 })).toBe("writable");
    expect(dockerParentTrustFailure({ kind: "directory", uid: 0, mode: 0o755 })).toBeUndefined();
  });
});

async function fakeDocker(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dim-installer-docker-runner-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "docker");
  await writeFile(executable, `#!/usr/bin/env node
const [command, ...args] = process.argv.slice(2);
if (command === "record") process.stdout.write(JSON.stringify(args));
else if (command === "output") process.stdout.write("x".repeat(1024));
else if (command === "wait") setTimeout(() => {}, 10000);
else if (command === "environment") process.stdout.write(JSON.stringify({
  dockerHost: process.env.DOCKER_HOST,
  path: process.env.PATH
}));
else if (command === "wait-tree") {
  const { spawn } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore"
  });
  writeFileSync(args[0], String(descendant.pid));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
else process.exitCode = 9;
`);
  await chmod(executable, 0o700);
  return executable;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}
