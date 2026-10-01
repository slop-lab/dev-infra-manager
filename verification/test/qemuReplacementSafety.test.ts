import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { http, readEvents, startService, waitForObservation } from "./qemuServiceTestSupport.js";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const projectRoot = workspaceRoot;
const serviceScript = resolve(projectRoot, ".dim/qemu-service.mjs");
const roots: string[] = [];
const processes: ChildProcess[] = [];
const servers: Server[] = [];

type SetupFixture = {
  readonly log: string;
  readonly replacementPid: string;
  readonly root: string;
  readonly serviceDirectory: string;
  readonly tools: string;
};

function qemuSection(setup: string, serviceDirectory: string): string {
  const start = setup.indexOf("qemu_service_dir=/tmp/dim-qemu-verification");
  const end = setup.indexOf("\n# Avoid inheriting", start);
  if (start < 0 || end < 0) throw new TypeError("QEMU setup section was not found");
  return `set -eu\n${setup.slice(start, end).replace(
    "qemu_service_dir=/tmp/dim-qemu-verification",
    `qemu_service_dir=${JSON.stringify(serviceDirectory)}`
  ).replace("qemu_node=/usr/bin/node", 'qemu_node="$DIM_TEST_NODE"')}`;
}

async function createSetupFixture(): Promise<SetupFixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-replacement-test-"));
  roots.push(root);
  const tools = resolve(root, "tools");
  const serviceDirectory = resolve(root, "service");
  const log = resolve(root, "replacement.log");
  const replacementPid = resolve(root, "replacement.pid");
  await mkdir(tools);
  await mkdir(serviceDirectory);
  await writeFile(log, "");
  await writeFile(resolve(tools, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  await writeFile(resolve(tools, "node"), `#!/usr/bin/env bash
case "\${1:-}" in *qemu-service-owner.mjs) exec "$DIM_TEST_REAL_NODE" "$@" ;; esac
printf 'replacement\n' >>"$DIM_TEST_REPLACEMENT_LOG"
printf '%s\n' "$$" >"$DIM_TEST_REPLACEMENT_PID"
exec "$DIM_TEST_REAL_NODE" --input-type=module -e '
  import { chmodSync } from "node:fs";
  import { createServer } from "node:http";
import { createOwnerRecord } from "${resolve(projectRoot, ".dim/qemu-service-owner.mjs")}";
import { captureSocketIdentity, createSocketLease, publishOwner } from "${resolve(projectRoot, ".dim/qemu-service-artifacts.mjs")}";
  const socketPath = process.env.DIM_QEMU_SERVICE_SOCKET;
  const server = createServer((_request, response) => response.end("{\\"status\\":\\"idle\\"}\\n"));
  server.listen(socketPath, async () => {
    await createSocketLease(socketPath, await captureSocketIdentity(socketPath));
    chmodSync(process.env.DIM_TEST_LEASE_PATH, 0o666);
    await publishOwner(process.env.DIM_TEST_OWNER_PATH, await createOwnerRecord(socketPath));
  });
'
`);
  await Promise.all([chmod(resolve(tools, "sleep"), 0o700), chmod(resolve(tools, "node"), 0o700)]);
  return { log, replacementPid, root, serviceDirectory, tools };
}

async function runSetup(fixture: SetupFixture) {
  const setup = await readFile(resolve(projectRoot, ".dim/setup.sh"), "utf8");
  return spawnSync("/usr/bin/bash", ["-c", qemuSection(setup, fixture.serviceDirectory)], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.tools}:/usr/bin:/bin`,
      DIM_TEST_REAL_NODE: process.execPath,
      DIM_TEST_NODE: resolve(fixture.tools, "node"),
      DIM_TEST_REPLACEMENT_LOG: fixture.log,
      DIM_TEST_OWNER_PATH: resolve(fixture.serviceDirectory, "service-owner.json"),
      DIM_TEST_LEASE_PATH: resolve(fixture.serviceDirectory, ".service.sock.lease"),
      DIM_TEST_REPLACEMENT_PID: fixture.replacementPid,
      DIM_WORKSPACE_KVM: "1"
    },
    timeout: 10_000
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

afterEach(async () => {
  await Promise.all(processes.splice(0).map(stopProcess));
  await Promise.all(servers.splice(0).map(async (server) => {
    if (server.listening) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }));
  await Promise.all(roots.map(async (root) => {
    try {
      process.kill(Number.parseInt(await readFile(resolve(root, "replacement.pid"), "utf8"), 10), "SIGKILL");
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error)
        || (error.code !== "ENOENT" && error.code !== "ESRCH")) throw error;
    }
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("QEMU replacement ownership", () => {
  it("fails closed and preserves artifacts when the PID record is malformed", async () => {
    const fixture = await createSetupFixture();
    const pidPath = resolve(fixture.serviceDirectory, "service.pid");
    const socketPath = resolve(fixture.serviceDirectory, "service.sock");
    await writeFile(pidPath, "12x\n");
    await writeFile(socketPath, "owned\n");

    const result = await runSetup(fixture);

    expect.soft(result.status).not.toBe(0);
    expect.soft(await readFile(pidPath, "utf8")).toBe("12x\n");
    expect.soft(await readFile(socketPath, "utf8")).toBe("owned\n");
    expect(await readFile(fixture.log, "utf8")).toBe("");
  });

  it("fails closed without signalling a live foreign PID", async () => {
    const fixture = await createSetupFixture();
    const foreign = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    processes.push(foreign);
    const pidPath = resolve(fixture.serviceDirectory, "service.pid");
    const socketPath = resolve(fixture.serviceDirectory, "service.sock");
    await writeFile(pidPath, `${foreign.pid}\n`);
    await writeFile(socketPath, "foreign-owned\n");

    const result = await runSetup(fixture);

    expect.soft(result.status).not.toBe(0);
    expect.soft(() => process.kill(foreign.pid ?? 0, 0)).not.toThrow();
    expect.soft(await readFile(pidPath, "utf8")).toBe(`${foreign.pid}\n`);
    expect.soft(await readFile(socketPath, "utf8")).toBe("foreign-owned\n");
    expect(await readFile(fixture.log, "utf8")).toBe("");
  });

  it("fails closed and preserves a socket that has no PID record", async () => {
    const fixture = await createSetupFixture();
    const socketPath = resolve(fixture.serviceDirectory, "service.sock");
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, resolveListen);
    });
    const before = await lstat(socketPath, { bigint: true });

    const result = await runSetup(fixture);
    const after = await lstat(socketPath, { bigint: true });

    expect.soft(result.status).not.toBe(0);
    expect.soft({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
    expect(await readFile(fixture.log, "utf8")).toBe("");
  });

  it("rejects obsolete service.pid residue instead of accepting its PID", async () => {
    const fixture = await createSetupFixture();
    const exited = spawn("/usr/bin/true");
    await new Promise<void>((resolveExit) => exited.once("exit", () => resolveExit()));
    await writeFile(resolve(fixture.serviceDirectory, "service.pid"), `${exited.pid}\n`);
    await writeFile(resolve(fixture.serviceDirectory, "service.sock"), "stale\n");

    const result = await runSetup(fixture);
    expect.soft(result.status).not.toBe(0);
    expect.soft(await readFile(resolve(fixture.serviceDirectory, "service.pid"), "utf8")).toBe(`${exited.pid}\n`);
    expect(await readFile(fixture.log, "utf8")).toBe("");
  });

  it("refuses a second direct service without replacing the active socket or run tree", async () => {
    const fixture = await startService("hold");
    const started = await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    await readEvents(fixture, "ready\n");
    const runNames = await readdir(fixture.runsRoot);
    const socketIdentity = await lstat(fixture.socketPath, { bigint: true });
    const second = spawn(process.execPath, [serviceScript], {
      env: {
        ...process.env,
        DIM_QEMU_LAUNCHER: "/bin/false",
        DIM_QEMU_SERVICE_SOCKET: fixture.socketPath,
        DIM_QEMU_SOURCE_ROOT: fixture.sourceRoot
      },
      stdio: "ignore"
    });
    processes.push(second);

    const outcome = await Promise.race([
      new Promise<"exited">((resolveExit) => second.once("exit", () => resolveExit("exited"))),
      waitForObservation(async () => {
        const recorded = JSON.parse(await readFile(resolve(fixture.root, "service-owner.json"), "utf8")) as { pid: string };
        return Number(recorded.pid) !== fixture.process.pid ? "replaced" as const : undefined;
      }, 1_000)
    ]);
    const status = await http(fixture, { method: "GET", path: "/v1/status" });

    expect.soft(started.status).toBe(202);
    expect.soft(outcome).toBe("exited");
    expect.soft(status.body).toContain('"status":"running"');
    expect.soft((await lstat(fixture.socketPath, { bigint: true })).ino).toBe(socketIdentity.ino);
    expect(await readdir(fixture.runsRoot)).toEqual(runNames);
  });

  it("rejects a pre-existing deterministic lease without replacing it", async () => {
    const fixture = await createSetupFixture();
    const leasePath = resolve(fixture.serviceDirectory, ".service.sock.lease");
    await writeFile(leasePath, "foreign lease\n");

    const service = spawn(process.execPath, [serviceScript], {
      env: { ...process.env, DIM_QEMU_LAUNCHER: "/bin/false",
        DIM_QEMU_SERVICE_SOCKET: resolve(fixture.serviceDirectory, "service.sock"),
        DIM_QEMU_SOURCE_ROOT: fixture.root },
      stdio: "ignore",
    });
    processes.push(service);
    await new Promise<void>((resolveExit) => service.once("exit", () => resolveExit()));

    expect.soft(service.exitCode).not.toBe(0);
    expect.soft(await readFile(leasePath, "utf8")).toBe("foreign lease\n");
    await expect(lstat(resolve(fixture.serviceDirectory, "service.sock"))).rejects.toThrow();
  });
});