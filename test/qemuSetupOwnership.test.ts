import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForObservation } from "./qemuServiceTestSupport.js";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const projectRoot = resolve(workspaceRoot, "project");
const serviceScript = resolve(projectRoot, ".dim/qemu-service.mjs");
const roots: string[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];

type Fixture = {
  readonly cliLog: string;
  readonly newPidFile: string;
  readonly root: string;
  readonly serviceDirectory: string;
  readonly tools: string;
};

function qemuSection(setup: string, serviceDirectory: string): string {
  const start = setup.indexOf("qemu_service_dir=/tmp/dim-qemu-verification");
  const end = setup.indexOf("\n# Avoid inheriting", start);
  if (start < 0 || end < 0) throw new TypeError("QEMU setup section was not found");
  return `set -eu\n${setup.slice(start, end).replace(
    "qemu_service_dir=/tmp/dim-qemu-verification", `qemu_service_dir=${JSON.stringify(serviceDirectory)}`,
  )}`;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-setup-owner-test-"));
  roots.push(root);
  const tools = resolve(root, "tools");
  const serviceDirectory = resolve(root, "service");
  const cliLog = resolve(root, "owner-cli.log");
  const newPidFile = resolve(root, "new-service.pid");
  const signalPreload = resolve(root, "signal-preload.mjs");
  await Promise.all([mkdir(tools), mkdir(serviceDirectory), writeFile(cliLog, "")]);
  await writeFile(signalPreload, `import { appendFileSync } from "node:fs";
process.on("SIGTERM", () => appendFileSync(process.env.DIM_TEST_SIGNAL_LOG, "SIGTERM\\n"));
`);
  await writeFile(resolve(tools, "node"), `#!/usr/bin/env bash
case "\${1:-}" in
  *qemu-service-owner.mjs) printf '%s\n' "$*" >>"$DIM_TEST_OWNER_CLI_LOG" ;;
  *qemu-service.mjs)
    printf '%s\n' "$$" >"$DIM_TEST_NEW_PID_FILE"
    if [[ "$DIM_TEST_READINESS" == unowned ]]; then
      trap 'printf "SIGTERM\\n" >>"$DIM_TEST_SIGNAL_LOG"' TERM
      while true; do /usr/bin/sleep 1; done
    fi
    if [[ "$DIM_TEST_READINESS" == mismatch ]]; then
      trap 'printf "SIGTERM\\n" >>"$DIM_TEST_SIGNAL_LOG"; exit 0' TERM
      "$DIM_TEST_REAL_NODE" "$@" &
      child=$!
      printf '%s\n' "$child" >"$DIM_TEST_CHILD_PID_FILE"
      wait "$child"
      exit 0
    fi
    exec "$DIM_TEST_REAL_NODE" --import "$DIM_TEST_SIGNAL_PRELOAD" "$@"
    ;;
esac
exec "$DIM_TEST_REAL_NODE" "$@"
`);
  await writeFile(resolve(tools, "curl"), `#!/usr/bin/env bash
test "$DIM_TEST_READINESS" = success || exit 22
exec /usr/bin/curl "$@"
`);
  await writeFile(resolve(tools, "sleep"), `#!/usr/bin/env bash
if [[ "$DIM_TEST_READINESS" == mismatch ]]; then
  while [[ ! -e "$DIM_TEST_READINESS_RELEASE" ]]; do /usr/bin/sleep 0.01; done
fi
`);
  await Promise.all(["node", "curl", "sleep"].map((name) => chmod(resolve(tools, name), 0o700)));
  return { cliLog, newPidFile, root, serviceDirectory, tools };
}

function setupEnvironment(fixture: Fixture, readiness: "failure" | "mismatch" | "success" | "unowned") {
  return {
    ...process.env,
    PATH: `${fixture.tools}:/usr/bin:/bin`,
    DIM_TEST_NEW_PID_FILE: fixture.newPidFile,
    DIM_TEST_CHILD_PID_FILE: resolve(fixture.root, "child-service.pid"),
    DIM_TEST_OWNER_CLI_LOG: fixture.cliLog,
    DIM_TEST_READINESS: readiness,
    DIM_TEST_READINESS_RELEASE: resolve(fixture.root, "readiness-release"),
    DIM_TEST_REAL_NODE: process.execPath,
    DIM_TEST_SIGNAL_LOG: resolve(fixture.root, "signals.log"),
    DIM_TEST_SIGNAL_PRELOAD: resolve(fixture.root, "signal-preload.mjs"),
    DIM_WORKSPACE_KVM: "1",
  };
}

async function setupCommand(fixture: Fixture): Promise<string> {
  return qemuSection(await readFile(resolve(projectRoot, ".dim/setup.sh"), "utf8"), fixture.serviceDirectory);
}

function runSetup(fixture: Fixture, command: string, readiness: "failure" | "success"): SpawnSyncReturns<string> {
  return spawnSync("/usr/bin/bash", ["-c", command], {
    cwd: projectRoot, encoding: "utf8", env: setupEnvironment(fixture, readiness), timeout: 10_000,
  });
}

function processIsLive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && error.message.includes("ESRCH")) return false;
    throw error;
  }
}

async function startOwnedService(fixture: Fixture): Promise<ChildProcess> {
  const socketPath = resolve(fixture.serviceDirectory, "service.sock");
  const sourceRoot = resolve(fixture.root, "source");
  await mkdir(sourceRoot);
  const child = spawn(process.execPath, [serviceScript], {
    cwd: projectRoot,
    env: { ...process.env, DIM_QEMU_LAUNCHER: "/bin/false", DIM_QEMU_SERVICE_SOCKET: socketPath, DIM_QEMU_SOURCE_ROOT: sourceRoot },
    stdio: "ignore",
  });
  children.push(child);
  await waitForObservation(async () => {
    try { return JSON.parse(await readFile(resolve(fixture.serviceDirectory, "service-owner.json"), "utf8")); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  });
  return child;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => {
    if (!server.listening) return resolveClose();
    server.close(() => resolveClose());
  })));
  for (const root of roots) {
    for (const pidFile of ["new-service.pid", "child-service.pid"]) {
      try {
        const pid = Number.parseInt(await readFile(resolve(root, pidFile), "utf8"), 10);
        if (processIsLive(pid)) process.kill(pid, "SIGKILL");
      } catch (error) {
        if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
  }
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("QEMU setup structured ownership", () => {
  it("retires an exact-live structured owner before starting replacement", async () => {
    const fixture = await createFixture();
    const oldService = await startOwnedService(fixture);

    const result = runSetup(fixture, await setupCommand(fixture), "success");
    const replacementPid = Number.parseInt(await readFile(fixture.newPidFile, "utf8"), 10);

    expect.soft(result.status).toBe(0);
    expect.soft(oldService.exitCode ?? oldService.signalCode).not.toBeNull();
    expect(replacementPid).not.toBe(oldService.pid);
  });

  it("uses exact structured retirement when readiness fails after owner publication", async () => {
    const fixture = await createFixture();

    const result = runSetup(fixture, await setupCommand(fixture), "failure");
    const cliCalls = await readFile(fixture.cliLog, "utf8");
    const failedPid = Number.parseInt(await readFile(fixture.newPidFile, "utf8"), 10);

    expect.soft(result.status).not.toBe(0);
    expect.soft(cliCalls.match(/retire .* 5000/g)).toHaveLength(2);
    expect.soft(processIsLive(failedPid)).toBe(false);
    await expect(lstat(resolve(fixture.serviceDirectory, "service-owner.json"))).rejects.toThrow();
    await expect(lstat(resolve(fixture.serviceDirectory, "service.sock"))).rejects.toThrow();
  });

  it("returns without signalling when a live service never publishes ownership", async () => {
    const fixture = await createFixture();
    const command = await setupCommand(fixture);

    const result = spawnSync("/usr/bin/bash", ["-c", command], {
      cwd: projectRoot, encoding: "utf8", env: setupEnvironment(fixture, "unowned"), timeout: 7_500,
    });
    const unownedPid = Number.parseInt(await readFile(fixture.newPidFile, "utf8"), 10);

    expect.soft(result.error).toBeUndefined();
    expect.soft(result.status).not.toBe(0);
    expect.soft(processIsLive(unownedPid)).toBe(true);
    expect.soft(result.stderr).toContain(String(unownedPid));
    expect.soft(result.stderr).toContain(resolve(fixture.serviceDirectory, "service-owner.json"));
    await expect(readFile(resolve(fixture.root, "signals.log"), "utf8")).rejects.toThrow();
  }, 10_000);

  it("does not signal or mutate a process whose published ownership is replaced during readiness", async () => {
    const fixture = await createFixture();
    const command = await setupCommand(fixture);
    const setup = spawn("/usr/bin/bash", ["-c", command], {
      cwd: projectRoot, env: setupEnvironment(fixture, "mismatch"), stdio: "ignore",
    });
    children.push(setup);
    await waitForObservation(async () => {
      try { return Number.parseInt(await readFile(fixture.newPidFile, "utf8"), 10); }
      catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
    });
    const socketPath = resolve(fixture.serviceDirectory, "service.sock");
    const ownerPath = resolve(fixture.serviceDirectory, "service-owner.json");
    await waitForObservation(async () => {
      try { return (await lstat(socketPath)).isSocket() ? true : undefined; }
      catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
    });
    await rm(socketPath);
    const foreign = createServer();
    servers.push(foreign);
    const foreignPath = resolve(fixture.serviceDirectory, "foreign.sock");
    await new Promise<void>((resolveListen) => foreign.listen(foreignPath, resolveListen));
    await link(foreignPath, socketPath);
    const socketIdentity = await lstat(socketPath, { bigint: true });
    const replacementOwner = resolve(fixture.serviceDirectory, "replacement-owner.json");
    await writeFile(replacementOwner, "foreign-owner\n");
    await rename(replacementOwner, ownerPath);
    await writeFile(resolve(fixture.root, "readiness-release"), "release\n");

    await new Promise<void>((resolveExit) => setup.once("exit", () => resolveExit()));

    await expect(readFile(resolve(fixture.root, "signals.log"), "utf8")).rejects.toThrow();
    const surviving = await lstat(socketPath, { bigint: true });
    expect.soft({ device: surviving.dev, inode: surviving.ino }).toEqual({ device: socketIdentity.dev, inode: socketIdentity.ino });
    expect(await readFile(ownerPath, "utf8")).toBe("foreign-owner\n");
  });
});
