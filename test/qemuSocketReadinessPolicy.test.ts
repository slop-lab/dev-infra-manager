import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForObservation } from "./qemuServiceTestSupport.js";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const projectRoot = resolve(workspaceRoot, "project");
const fixtureRoots: string[] = [];
const oldServices: { readonly process: ChildProcess; readonly servicePid: number }[] = [];

function qemuSection(setup: string, serviceDirectory: string): string {
  const start = setup.indexOf("qemu_service_dir=/tmp/dim-qemu-verification");
  const end = setup.indexOf("\n# Avoid inheriting", start);
  if (start < 0 || end < 0) throw new TypeError("QEMU setup section was not found");
  return `set -eu\n${setup.slice(start, end).replace(
    "qemu_service_dir=/tmp/dim-qemu-verification",
    `qemu_service_dir=${JSON.stringify(serviceDirectory)}`
  )}`;
}

async function createFixture(): Promise<{
  readonly log: string; readonly replacementPidFile: string; readonly root: string;
  readonly serviceDirectory: string; readonly tools: string;
}> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-setup-test-"));
  fixtureRoots.push(root);
  const tools = resolve(root, "tools");
  const serviceDirectory = resolve(root, "service");
  const log = resolve(root, "replacement.log");
  const replacementPidFile = resolve(root, "replacement.pid");
  await mkdir(tools);
  await mkdir(serviceDirectory);
  await writeFile(log, "");
  await writeFile(resolve(tools, "sleep"), `#!/usr/bin/env bash
if [[ "\${DIM_TEST_REAL_SLEEP:-0}" == 1 ]]; then /usr/bin/sleep "$@"; fi
`);
  await writeFile(resolve(tools, "node"), `#!/usr/bin/env bash
if kill -0 "$DIM_TEST_OLD_PID" 2>/dev/null; then state=alive; else state=exited; fi
printf 'replacement old_pid=%s state=%s\n' "$DIM_TEST_OLD_PID" "$state" >>"$DIM_TEST_REPLACEMENT_LOG"
printf '%s\n' "$$" >"$DIM_TEST_REPLACEMENT_PID"
exec "$DIM_TEST_REAL_NODE" --input-type=module -e '
  import { chmodSync, writeFileSync } from "node:fs";
  import { createServer } from "node:http";
  import { dirname, resolve } from "node:path";
  const socketPath = process.env.DIM_QEMU_SERVICE_SOCKET;
  const server = createServer((_request, response) => response.end("{\\"status\\":\\"idle\\"}\\n"));
  server.listen(socketPath, () => {
    chmodSync(socketPath, 0o666);
    writeFileSync(resolve(dirname(socketPath), "service.pid"), process.pid + "\\n");
  });
'
`);
  await Promise.all([chmod(resolve(tools, "sleep"), 0o700), chmod(resolve(tools, "node"), 0o700)]);
  return { log, replacementPidFile, root, serviceDirectory, tools };
}

async function startOldService(serviceDirectory: string, exitDelayMilliseconds?: number): Promise<number> {
  const supervisorScript = resolve(serviceDirectory, "supervise-old.bash");
  const handler = exitDelayMilliseconds === undefined
    ? "process.on('SIGTERM', () => {});"
    : `process.on('SIGTERM', () => setTimeout(() => process.exit(0), ${exitDelayMilliseconds}));`;
  await writeFile(supervisorScript, `#!/usr/bin/env bash
DIM_TEST_SERVICE_DIR="$3" "$1" -e "$2 require('node:fs').writeFileSync(process.env.DIM_TEST_SERVICE_DIR + '/service.pid', process.pid + '\\n'); setInterval(() => {}, 1000)" .dim/qemu-service.mjs &
service_pid=$!
wait "$service_pid"
`);
  await chmod(supervisorScript, 0o700);
  const supervisor = spawn("/usr/bin/bash", [supervisorScript, process.execPath, handler, serviceDirectory], {
    cwd: projectRoot,
    stdio: "ignore"
  });
  const servicePid = await waitForObservation(async () => {
    try {
      return Number.parseInt(await readFile(resolve(serviceDirectory, "service.pid"), "utf8"), 10);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  });
  oldServices.push({ process: supervisor, servicePid });
  return servicePid;
}

type SetupRun = {
  readonly fixture: Awaited<ReturnType<typeof createFixture>>;
  readonly oldPid: number;
  readonly realSleep: boolean;
  readonly section: string;
};

function runQemuSetup(run: SetupRun) {
  return spawnSync("/usr/bin/bash", ["-c", run.section], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${run.fixture.tools}:/usr/bin:/bin`,
      DIM_TEST_OLD_PID: String(run.oldPid),
      DIM_TEST_REAL_SLEEP: run.realSleep ? "1" : "0",
      DIM_TEST_REAL_NODE: process.execPath,
      DIM_TEST_REPLACEMENT_LOG: run.fixture.log,
      DIM_TEST_REPLACEMENT_PID: run.fixture.replacementPidFile,
      DIM_WORKSPACE_KVM: "1"
    },
    timeout: 10_000
  });
}

afterEach(async () => {
  await Promise.all(oldServices.splice(0).map(async ({ process: supervisor, servicePid }) => {
    try {
      process.kill(servicePid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ESRCH")) throw error;
    }
    if (supervisor.exitCode === null) {
      await new Promise<void>((resolveExit) => supervisor.once("exit", () => resolveExit()));
    }
  }));
  await Promise.all(fixtureRoots.map(async (root) => {
    try {
      process.kill(Number.parseInt(await readFile(resolve(root, "replacement.pid"), "utf8"), 10), "SIGKILL");
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error)
        || (error.code !== "ENOENT" && error.code !== "ESRCH")) throw error;
    }
  }));
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("canonical QEMU socket readiness", () => {
  it("waits for both the Unix socket and its client-usable mode", async () => {
    const setup = await readFile(resolve(projectRoot, ".dim/setup.sh"), "utf8");
    const readiness = setup.slice(
      setup.indexOf("for _ in $(seq 1 50); do", setup.indexOf("DIM_QEMU_SERVICE_SOCKET")),
      setup.indexOf("else", setup.indexOf("DIM_QEMU_SERVICE_SOCKET"))
    );

    expect(readiness).toContain('test -S "$qemu_service_dir/service.sock"');
    expect(readiness).toContain('stat -c %a "$qemu_service_dir/service.sock"');
    expect(readiness.match(/= 666/g)).toHaveLength(2);
  });

  it("runs strict owner retirement before installing or starting replacement", async () => {
    const setup = await readFile(resolve(projectRoot, ".dim/setup.sh"), "utf8");
    const retirement = setup.indexOf("qemu-service-owner.mjs retire");
    const replacementStart = setup.indexOf("install -m 0500 .dim/qemu-verify.bash");

    expect.soft(retirement).toBeGreaterThan(0);
    expect(replacementStart).toBeGreaterThan(retirement);
  });

  it("rejects obsolete PID-only ownership even after its process exits", async () => {
    const fixture = await createFixture();
    const oldPid = await startOldService(fixture.serviceDirectory, 75);
    const setup = await readFile(resolve(projectRoot, ".dim/setup.sh"), "utf8");

    const result = runQemuSetup({
      fixture, oldPid, realSleep: true, section: qemuSection(setup, fixture.serviceDirectory)
    });

    expect.soft(result.status).not.toBe(0);
    expect.soft(await readFile(fixture.log, "utf8")).toBe("");
    expect(await readFile(resolve(fixture.serviceDirectory, "service.pid"), "utf8")).toBe(`${oldPid}\n`);
  });

  it("fails closed without unlinking or starting replacement when the exact old PID survives timeout", async () => {
    const fixture = await createFixture();
    const oldPid = await startOldService(fixture.serviceDirectory);
    const setup = await readFile(resolve(projectRoot, ".dim/setup.sh"), "utf8");

    const result = runQemuSetup({
      fixture, oldPid, realSleep: false, section: qemuSection(setup, fixture.serviceDirectory)
    });

    expect.soft(result.status).not.toBe(0);
    expect.soft(await readFile(fixture.log, "utf8")).toBe("");
    expect(await readFile(resolve(fixture.serviceDirectory, "service.pid"), "utf8")).toBe(`${oldPid}\n`);
  });
});
