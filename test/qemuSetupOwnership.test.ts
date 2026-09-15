import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForObservation } from "./qemuServiceTestSupport.js";
import { ownerPid, processIsLive } from "./qemuSetupTestSupport.js";

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
  ).replace("qemu_node=/usr/bin/node", 'qemu_node="$DIM_TEST_NODE"')
    .replaceAll("sudo -n ", '"$DIM_TEST_SUDO" ')
    .replaceAll("/usr/bin/env -i", "/usr/bin/env")}`;
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
if (process.env.DIM_TEST_READINESS === "mismatch") {
  process.on("SIGTERM", () => appendFileSync(process.env.DIM_TEST_SIGNAL_LOG, "SIGTERM\\n"));
}
`);
  await writeFile(resolve(tools, "node"), `#!/usr/bin/env bash
case "\${1:-}" in
  *qemu-service-owner.mjs)
    printf '%s\n' "$*" >>"$DIM_TEST_OWNER_CLI_LOG"
    if [[ "$DIM_TEST_READINESS" == mismatch && -e "$DIM_TEST_READINESS_RELEASE" ]]; then exit 1; fi
    ;;
  *qemu-service.mjs)
    printf '%s\n' "$$" >"$DIM_TEST_NEW_PID_FILE"
    if [[ "$DIM_TEST_READINESS" == unowned ]]; then
      trap 'printf "SIGTERM\\n" >>"$DIM_TEST_SIGNAL_LOG"' TERM
      while true; do /usr/bin/sleep 1; done
    fi
    if [[ "$DIM_TEST_READINESS" == mismatch ]]; then
      trap 'printf "SIGTERM\\n" >>"$DIM_TEST_SIGNAL_LOG"; exit 0' TERM
      /usr/bin/nohup "$DIM_TEST_REAL_NODE" "$@" >/dev/null 2>&1 &
      child=$!
      printf '%s\n' "$child" >"$DIM_TEST_CHILD_PID_FILE"
      exit 0
    fi
    exec "$DIM_TEST_REAL_NODE" --import "$DIM_TEST_SIGNAL_PRELOAD" "$@"
    ;;
  -e)
    if [[ "$DIM_TEST_READINESS" == mismatch && -e "$DIM_TEST_READINESS_RELEASE" ]]; then exit 1; fi
    ;;
esac
exec "$DIM_TEST_REAL_NODE" "$@"
`);
  await writeFile(resolve(tools, "sudo"), `#!/usr/bin/env bash
exec "$@"
`);
  await writeFile(resolve(tools, "curl"), `#!/usr/bin/env bash
test "$DIM_TEST_READINESS" = success || exit 22
exec /usr/bin/curl "$@"
`);
  await writeFile(resolve(tools, "sleep"), `#!/usr/bin/env bash
target="$DIM_TEST_OWNER_PATH"
[[ "$DIM_TEST_READINESS" != unowned ]] || target="$DIM_TEST_NEW_PID_FILE"
if [[ "$DIM_TEST_READINESS" == mismatch && -e "$target" ]]; then target="$DIM_TEST_READINESS_RELEASE"; fi
[[ -e "$target" ]] || exec "$DIM_TEST_REAL_NODE" -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const target = process.argv[1];
  const complete = () => {
    if (!fs.existsSync(target)) return;
    watcher.close();
    process.exit(0);
  };
  const watcher = fs.watch(path.dirname(target), (_event, name) => {
    if (name === path.basename(target)) complete();
  });
  complete();
' "$target"
`);
  await Promise.all(["node", "curl", "sleep", "sudo"].map((name) => chmod(resolve(tools, name), 0o700)));
  return { cliLog, newPidFile, root, serviceDirectory, tools };
}

function setupEnvironment(fixture: Fixture, readiness: "failure" | "mismatch" | "success" | "unowned") {
  return {
    ...process.env,
    PATH: `${fixture.tools}:/usr/bin:/bin`,
    DIM_TEST_NEW_PID_FILE: fixture.newPidFile,
    DIM_TEST_NODE: resolve(fixture.tools, "node"),
    DIM_TEST_SUDO: resolve(fixture.tools, "sudo"),
    DIM_TEST_CHILD_PID_FILE: resolve(fixture.root, "child-service.pid"),
    DIM_TEST_OWNER_CLI_LOG: fixture.cliLog,
    DIM_TEST_OWNER_PATH: resolve(fixture.serviceDirectory, "service-owner.json"),
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
    cwd: projectRoot, encoding: "utf8", env: setupEnvironment(fixture, readiness), timeout: 20_000,
  });
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
        if (processIsLive(pid)) {
          process.kill(pid, "SIGKILL");
          await waitForObservation(async () => processIsLive(pid) ? undefined : true);
        }
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
    expect(result, result.stderr).toMatchObject({ status: 0 });
    const replacementPid = await ownerPid(fixture.serviceDirectory);
    expect.soft(oldService.exitCode ?? oldService.signalCode).not.toBeNull();
    expect(replacementPid).not.toBe(oldService.pid);
  });

  it("uses exact structured retirement when readiness fails after owner publication", async () => {
    const fixture = await createFixture();

    const result = runSetup(fixture, await setupCommand(fixture), "failure");
    expect(result.status, result.stderr).not.toBe(0);
    const cliCalls = await readFile(fixture.cliLog, "utf8");
    const failedPid = Number.parseInt(await readFile(fixture.newPidFile, "utf8"), 10);

    expect.soft(cliCalls).toContain("retire-exact");
    expect.soft(processIsLive(failedPid)).toBe(false);
    await expect(lstat(resolve(fixture.serviceDirectory, "service-owner.json"))).rejects.toThrow();
    await expect(lstat(resolve(fixture.serviceDirectory, "service.sock"))).rejects.toThrow();
  }, 25_000);

  it("returns without signalling when a live service never publishes ownership", async () => {
    const fixture = await createFixture();
    const command = await setupCommand(fixture);

    const result = spawnSync("/usr/bin/bash", ["-c", command], {
      cwd: projectRoot, encoding: "utf8", env: setupEnvironment(fixture, "unowned"), timeout: 20_000,
    });
    expect(result.status, result.stderr).not.toBe(0);
    const unownedPid = Number.parseInt(await readFile(fixture.newPidFile, "utf8"), 10);

    expect.soft(result.error).toBeUndefined();
    expect.soft(processIsLive(unownedPid)).toBe(true);
    expect.soft(result.stderr).toContain(String(unownedPid));
    expect.soft(result.stderr).toContain(resolve(fixture.serviceDirectory, "service-owner.json"));
    await expect(readFile(resolve(fixture.root, "signals.log"), "utf8")).rejects.toThrow();
  }, 25_000);

  it("does not signal or mutate a process whose published ownership is replaced during readiness", async () => {
    const fixture = await createFixture();
    const command = await setupCommand(fixture);
    const setup = spawn("/usr/bin/bash", ["-c", command], {
      cwd: projectRoot, env: setupEnvironment(fixture, "mismatch"), stdio: "ignore",
    });
    children.push(setup);
    await waitForObservation(async () => {
      try { return await ownerPid(fixture.serviceDirectory); }
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

    if (setup.exitCode === null && setup.signalCode === null) {
      await new Promise<void>((resolveExit) => setup.once("exit", () => resolveExit()));
    }

    await expect(readFile(resolve(fixture.root, "signals.log"), "utf8")).rejects.toThrow();
    const surviving = await lstat(socketPath, { bigint: true });
    expect.soft({ device: surviving.dev, inode: surviving.ino }).toEqual({ device: socketIdentity.dev, inode: socketIdentity.ino });
    expect(await readFile(ownerPath, "utf8")).toBe("foreign-owner\n");
  }, 15_000);
});
