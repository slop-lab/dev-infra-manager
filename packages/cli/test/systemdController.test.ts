import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { startSystemdManagedController } from "../../../../core/packages/cli/src/systemd-controller.js";

const cli = fileURLToPath(new URL("../../../../core/packages/cli/src/cli.ts", import.meta.url));
const packageDirectory = fileURLToPath(new URL("../../../../core/packages/cli", import.meta.url));
const tsxImport = import.meta.resolve("tsx");

test("successful controller restart keeps the existing systemd command path", async () => {
  const fixture = await createSystemdFixture("success");
  const runtimeRoot = path.join(fixture.root, "runtime");
  const options = lifecycleOptionsForBackend("sysbox", {
    ...fixture.env,
    DIM_STATE_ROOT: path.join(fixture.root, "state"),
    XDG_RUNTIME_DIR: runtimeRoot
  });
  const socketPaths = [
    options.controllerSocketPath,
    options.agentControllerSocketPath,
    options.adminControllerSocketPath
  ];
  await Promise.all(socketPaths.map(async (socketPath) => await mkdir(path.dirname(socketPath), { recursive: true })));
  const servers = socketPaths.map((socketPath) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    server.listen(socketPath);
    return server;
  });
  const previousPath = process.env.PATH;
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  const previousCommandLog = process.env.DIM_TEST_COMMAND_LOG;
  const previousMode = process.env.DIM_TEST_SYSTEMD_MODE;
  process.env.PATH = fixture.env.PATH;
  process.env.XDG_CONFIG_HOME = fixture.env.XDG_CONFIG_HOME;
  process.env.DIM_TEST_COMMAND_LOG = fixture.env.DIM_TEST_COMMAND_LOG;
  process.env.DIM_TEST_SYSTEMD_MODE = fixture.env.DIM_TEST_SYSTEMD_MODE;
  try {
    await Promise.all(servers.map(async (server) => await once(server, "listening")));
    await mkdir(options.controllerRuntimeDirectory, { recursive: true });
    await writeFile(path.join(options.controllerRuntimeDirectory, "controller.pid"), `${process.pid}\n`);

    await startSystemdManagedController(options);

    assert.match(await readFile(fixture.commandLog, "utf8"), /systemctl --user restart dim-controller\.service/);
    assert.doesNotMatch(await readFile(fixture.commandLog, "utf8"), /journalctl|systemctl --user show/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    if (previousCommandLog === undefined) delete process.env.DIM_TEST_COMMAND_LOG;
    else process.env.DIM_TEST_COMMAND_LOG = previousCommandLog;
    if (previousMode === undefined) delete process.env.DIM_TEST_SYSTEMD_MODE;
    else process.env.DIM_TEST_SYSTEMD_MODE = previousMode;
    await Promise.all(servers.map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))));
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("controller restart reports bounded causal systemd startup diagnostics", async () => {
  const fixture = await createSystemdFixture("failed");
  try {
    const result = runControllerRestart(fixture);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /could not start DIM controller with systemd: systemd restart failed/);
    assert.match(result.stderr, /controller service state: failed/);
    assert.match(result.stderr, /controller startup failed while initializing plugin routes: ingress startup refused/);
    assert.doesNotMatch(result.stderr, /systemctl-secret|journal-secret/);
    assert.match(result.stderr, /\[diagnostic truncated\]/);
    assert.ok(result.stderr.length < 4_500);
    assert.match(
      await readFile(fixture.commandLog, "utf8"),
      /journalctl --user --unit dim-controller\.service --lines 20 --no-pager --output cat/
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("controller restart preserves the original systemd failure when journal access is denied", async () => {
  const fixture = await createSystemdFixture("denied");
  try {
    const result = runControllerRestart(fixture);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /could not start DIM controller with systemd: systemd restart failed/);
    assert.doesNotMatch(result.stderr, /journal permission denied|systemctl-secret/);
    assert.match(await readFile(fixture.commandLog, "utf8"), /^journalctl /m);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("controller restart distinguishes a stopped service from a failed service", async () => {
  const fixture = await createSystemdFixture("stopped");
  try {
    const result = runControllerRestart(fixture);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /controller service state: stopped/);
    assert.doesNotMatch(result.stderr, /controller service state: failed/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

type SystemdFixture = {
  readonly root: string;
  readonly commandLog: string;
  readonly env: NodeJS.ProcessEnv;
};

async function createSystemdFixture(mode: "failed" | "denied" | "stopped" | "success"): Promise<SystemdFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "dim-controller-systemd-"));
  const bin = path.join(root, "bin");
  const configHome = path.join(root, "config");
  const commandLog = path.join(root, "commands.log");
  await mkdir(path.join(configHome, "dim"), { recursive: true });
  await mkdir(bin);
  await writeFile(
    path.join(configHome, "dim", "config.json"),
    `${JSON.stringify({ schemaVersion: 1, workspaceBackend: "sysbox" })}\n`
  );
  await writeFile(commandLog, "");
  await writeFile(path.join(bin, "systemctl"), `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$DIM_TEST_COMMAND_LOG"
if [ "$2" = show ]; then
  if [ "$DIM_TEST_SYSTEMD_MODE" = stopped ]; then
    printf 'ActiveState=inactive\\nSubState=dead\\nResult=success\\nExecMainStatus=0\\n'
  else
    printf 'ActiveState=failed\\nSubState=failed\\nResult=exit-code\\nExecMainStatus=2\\n'
  fi
  exit 0
fi
if [ "$2" = restart ]; then
  if [ "$DIM_TEST_SYSTEMD_MODE" = success ]; then exit 0; fi
  printf 'systemd restart failed PASSWORD=systemctl-secret\\n' >&2
  exit 1
fi
exit 0
`);
  await writeFile(path.join(bin, "journalctl"), `#!/bin/sh
printf 'journalctl %s\\n' "$*" >> "$DIM_TEST_COMMAND_LOG"
if [ "$DIM_TEST_SYSTEMD_MODE" = denied ]; then
  printf 'journal permission denied\\n' >&2
  exit 1
fi
printf 'controller startup failed while initializing plugin routes: ingress startup refused TOKEN=journal-secret\\n'
if [ "$DIM_TEST_SYSTEMD_MODE" = failed ]; then
  index=0
  while [ "$index" -lt 5000 ]; do printf x; index=$((index + 1)); done
  printf '\\n'
fi
`);
  await chmod(path.join(bin, "systemctl"), 0o700);
  await chmod(path.join(bin, "journalctl"), 0o700);
  return {
    root,
    commandLog,
    env: {
      ...process.env,
      HOME: root,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      XDG_CONFIG_HOME: configHome,
      XDG_RUNTIME_DIR: `/run/user/${process.getuid?.() ?? 0}`,
      DIM_CONFIG_PATH: path.join(configHome, "dim", "config.json"),
      DIM_TEST_COMMAND_LOG: commandLog,
      DIM_TEST_SYSTEMD_MODE: mode
    }
  };
}

function runControllerRestart(fixture: SystemdFixture) {
  return spawnSync(
    process.execPath,
    ["--import", tsxImport, cli, "controller", "restart"],
    { cwd: packageDirectory, encoding: "utf8", env: fixture.env }
  );
}
