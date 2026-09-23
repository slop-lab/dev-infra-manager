import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseOwnerRecord } from "../../project/.dim/qemu-service-owner.mjs";
import {
  copyLifecycleSnapshots, lifecycleEnvironment, qemuSetupSection, qemuTeardownSection, type QemuLifecycleFixture,
} from "./qemuLifecycleSnapshotTestSupport.js";
import { waitForObservation } from "./qemuServiceTestSupport.js";
import { ownerPid, ownershipSignalPreloadScript, processIsLive, startOwnedServiceProcess } from "./qemuSetupTestSupport.js";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const projectRoot = resolve(workspaceRoot, "project");
const roots: string[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];

type Fixture = QemuLifecycleFixture & {
  readonly newLifecycleRoot: string;
  readonly oldLifecycleRoot: string;
};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-setup-owner-test-"));
  roots.push(root);
  const tools = resolve(root, "tools");
  const serviceDirectory = resolve(root, "service");
  const cliLog = resolve(root, "owner-cli.log");
  const newPidFile = resolve(root, "new-service.pid");
  const signalPreload = resolve(root, "signal-preload.mjs");
  await Promise.all([mkdir(tools), mkdir(serviceDirectory), mkdir(resolve(root, "workspace")), writeFile(cliLog, "")]);
  const { newLifecycleRoot, oldLifecycleRoot } = await copyLifecycleSnapshots(projectRoot, root);
  await writeFile(signalPreload, ownershipSignalPreloadScript());
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
  return { cliLog, newLifecycleRoot, newPidFile, oldLifecycleRoot, root, serviceDirectory, tools };
}

async function setupCommand(fixture: Fixture): Promise<string> {
  return qemuSetupSection(await readFile(resolve(fixture.newLifecycleRoot, ".dim/setup.sh"), "utf8"), fixture.serviceDirectory);
}

function runSetup(fixture: Fixture, command: string, readiness: "failure" | "success"): SpawnSyncReturns<string> {
  return spawnSync("/usr/bin/bash", ["-c", command], {
    cwd: fixture.newLifecycleRoot, encoding: "utf8", env: lifecycleEnvironment(fixture, readiness), timeout: 20_000,
  });
}

async function startOwnedService(fixture: Fixture, blockActivation = false): Promise<ChildProcess> {
  const activationRelease = resolve(fixture.root, "activation-release");
  if (!blockActivation) await writeFile(activationRelease, "release\n");
  const { child, ready } = startOwnedServiceProcess(fixture);
  children.push(child);
  await ready;
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
  it("waits for full service activation after owner publication", async () => {
    const fixture = await createFixture();
    let returned = false;
    const starting = startOwnedService(fixture, true).then((service) => {
      returned = true;
      return service;
    });
    await waitForObservation(async () => {
      try { return await readFile(resolve(fixture.root, "activation-started"), "utf8"); }
      catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
    });
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));

    expect.soft(returned, "owner publication must not be treated as service readiness").toBe(false);
    await writeFile(resolve(fixture.root, "activation-release"), "release\n");
    await starting;
  });

  it("retires an exact-live structured owner before starting replacement", async () => {
    const fixture = await createFixture();
    const oldService = await startOwnedService(fixture);

    const result = runSetup(fixture, await setupCommand(fixture), "success");
    expect(result, result.stderr).toMatchObject({ status: 0 });
    const replacementPid = await ownerPid(fixture.serviceDirectory);
    const owner = parseOwnerRecord(JSON.parse(await readFile(resolve(fixture.serviceDirectory, "service-owner.json"), "utf8")));
    const serviceDirectoryIdentity = await stat(fixture.serviceDirectory, { bigint: true });
    expect.soft(oldService.exitCode ?? oldService.signalCode).not.toBeNull();
    expect(replacementPid).not.toBe(oldService.pid);
    expect(owner.cwd).toEqual({
      device: serviceDirectoryIdentity.dev.toString(),
      inode: serviceDirectoryIdentity.ino.toString(),
      path: fixture.serviceDirectory,
    });
  });

  it("retires an exact old-snapshot owner from new-snapshot teardown", async () => {
    const fixture = await createFixture();
    const oldService = await startOwnedService(fixture);

    const result = spawnSync("/bin/sh", ["-c", await qemuTeardownSection(fixture.newLifecycleRoot, fixture.serviceDirectory)], {
      cwd: fixture.newLifecycleRoot, encoding: "utf8", env: lifecycleEnvironment(fixture, "success"), timeout: 20_000,
    });
    if (oldService.exitCode === null && oldService.signalCode === null) {
      await new Promise<void>((resolveExit) => oldService.once("exit", () => resolveExit()));
    }

    expect.soft(result.status, result.stderr).toBe(0);
    expect.soft(oldService.exitCode ?? oldService.signalCode).not.toBeNull();
    await expect(lstat(resolve(fixture.serviceDirectory, "service-owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
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
      cwd: fixture.newLifecycleRoot, encoding: "utf8", env: lifecycleEnvironment(fixture, "unowned"), timeout: 20_000,
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
      cwd: fixture.newLifecycleRoot, env: lifecycleEnvironment(fixture, "mismatch"), stdio: "ignore",
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
