import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { before } from "node:test";
import { buildPublishedCli } from "./publishedCliFixture.js";

const packageDirectory = fileURLToPath(new URL("../../../../core/packages/cli", import.meta.url));
const cli = path.join(packageDirectory, "dist", "cli.js");
const sourceCli = fileURLToPath(new URL("../../../../core/packages/cli/src/cli.ts", import.meta.url));
const tsxImport = import.meta.resolve("tsx");
const buildLock = path.join(tmpdir(), "dim-cli-package-version-build.lock");

before(() => {
  buildPublishedCli(process.env);
});

test("built controller denies startup when an absent host managed-Git lease cannot be reconciled", async () => {
  const fixture = await createFixture(undefined, []);
  await installPlugin(fixture, "reconciliation-failure-plugin");
  await installDocker(fixture, `printf '%s\n' "$*" >> "$DIM_DOCKER_CALLS"
printf 'lease endpoint refused\n' >&2
exit 1`);

  try {
    const result = runController(fixture);

    assert.equal(result.status, 2);
    assert.equal(
      result.stderr,
      "controller startup failed while reconciling managed Git service: Failed to inspect Gitea container: lease endpoint refused\n"
    );
    await assertMissing(fixture.pluginMarker);
    await assertRuntimeMissing(fixture);
    assert.equal(JSON.parse(await readFile(fixture.hostPath, "utf8")).phase, "error");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("built controller does not bootstrap managed Git when no service record exists", async () => {
  const fixture = await createFixture(undefined, []);
  await rm(fixture.giteaPath);
  await installPlugin(fixture, "missing-service-plugin");
  await installDocker(fixture, `printf '%s\n' "$*" >> "$DIM_DOCKER_CALLS"
printf 'Docker must not run\n' >&2
exit 1`);

  try {
    const result = runController(fixture);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /controller startup failed while loading plugins: fixture plugin reached/);
    await assertMissing(fixture.dockerCalls);
    await assertMissing(fixture.hostPath);
    await assertRuntimeMissing(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("built controller reconciles an existing managed-Git lease before loading plugins on a ready host", async () => {
  const fixture = await createFixture("ready", []);
  await installPlugin(fixture, "reconciliation-success-plugin", true);
  await installDocker(fixture, `printf '%s\n' "$*" >> "$DIM_DOCKER_CALLS"
case "$1 $2" in
  "container inspect") printf '%s\n' '${containerInspect()}' ;;
  "network inspect") printf '%s\n' '${networkInspect()}' ;;
  "volume inspect") printf '%s\n' '${volumeInspect()}' ;;
  "exec --user") printf 'true\n' ;;
  "exec existing-gitea-id") printf '%s\n' '{"adminUsername":"admin","adminPassword":"admin-secret","writerUsername":"workspace","writerPassword":"writer-secret","maintainerUsername":"maintainer","maintainerPassword":"maintainer-secret"}' ;;
esac
exit 0`);
  const health = createServer((_request, response) => {
    response.writeHead(200).end("ok");
  });
  health.listen(0, "127.0.0.1");
  await once(health, "listening");
  const address = health.address();
  if (address === null || typeof address === "string") throw new Error("health fixture has no TCP port");
  fixture.environment.DIM_GITEA_PORT = String(address.port);
  await writeGiteaRecord(fixture, address.port);
  const controller = spawnController(fixture);

  try {
    await waitForPath(fixture.pluginMarker);
    await waitForPath(fixture.socket);
    assert.match(await readFile(fixture.dockerCalls, "utf8"), /^container inspect dim-gitea/m);
    assert.equal(JSON.parse(await readFile(fixture.giteaPath, "utf8")).phase, "ready");
  } finally {
    await stopController(controller, fixture.pidPath);
    await new Promise<void>((resolve, reject) => health.close((error) => error ? reject(error) : resolve()));
    await assertRuntimeMissing(fixture);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const phase of ["stopped", "starting"] as const) {
  test(`controller does not reconcile or recover a ${phase} host`, async () => {
    const fixture = await createFixture(phase, ["must-stay-pending"]);
    await installPlugin(fixture, `${phase}-host-plugin`);
    await installDocker(fixture, `printf '%s\n' "$*" >> "$DIM_DOCKER_CALLS"
printf 'Docker must not run\n' >&2
exit 1`);

    try {
      const result = runSourceController(fixture);

      assert.equal(result.status, 2);
      assert.match(result.stderr, /controller startup failed while loading plugins: fixture plugin reached/);
      await assertMissing(fixture.dockerCalls);
      assert.deepEqual(
        JSON.parse(await readFile(fixture.hostPath, "utf8")),
        hostRecord(phase, ["must-stay-pending"])
      );
      await assertRuntimeMissing(fixture);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

type Fixture = {
  readonly root: string; readonly stateRoot: string; readonly pluginHome: string;
  readonly pluginMarker: string; readonly dockerCalls: string; readonly hostPath: string;
  readonly giteaPath: string; readonly socket: string; readonly adminSocket: string;
  readonly agentSocket: string; readonly pidPath: string;
  readonly environment: NodeJS.ProcessEnv;
};

async function createFixture(phase: "ready" | "stopped" | "starting" | undefined, resumeWorkspaces: readonly string[]): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "dim-controller-host-reconcile-"));
  const stateRoot = path.join(root, "state");
  const configHome = path.join(root, "config");
  const fixture: Fixture = {
    root,
    stateRoot,
    pluginHome: path.join(root, "plugins"),
    pluginMarker: path.join(root, "plugin-loaded"),
    dockerCalls: path.join(root, "docker-calls"),
    hostPath: path.join(stateRoot, "host.json"),
    giteaPath: path.join(stateRoot, "services", "gitea.json"),
    socket: path.join(root, "controller.sock"),
    adminSocket: path.join(root, "admin.sock"),
    agentSocket: path.join(root, "agent.sock"),
    pidPath: path.join(root, "controller.pid"),
    environment: {
      ...process.env,
      DIM_CONFIG_PATH: path.join(configHome, "dim", "config.json"),
      DIM_DOCKER_CALLS: path.join(root, "docker-calls"),
      DIM_PLUGIN_HOME: path.join(root, "plugins"),
      DIM_STATE_ROOT: stateRoot,
      PATH: `${path.join(root, "bin")}:${process.env.PATH ?? ""}`,
      XDG_CONFIG_HOME: configHome
    }
  };
  await mkdir(path.join(configHome, "dim"), { recursive: true });
  await mkdir(path.dirname(fixture.giteaPath), { recursive: true });
  await writeFile(fixture.environment.DIM_CONFIG_PATH ?? "", `${JSON.stringify({ schemaVersion: 1, workspaceBackend: "sysbox" })}\n`);
  if (phase !== undefined) {
    await writeFile(fixture.hostPath, `${JSON.stringify(hostRecord(phase, resumeWorkspaces), null, 2)}\n`);
  }
  await writeGiteaRecord(fixture, 3300);
  return fixture;
}

function hostRecord(phase: "ready" | "stopped" | "starting", resumeWorkspaces: readonly string[]) {
  return {
    schemaVersion: 2,
    phase,
    resumeWorkspaces,
    restartCiRunners: [],
    resumeManagedContainers: [],
    updatedAt: "2026-10-02T00:00:00.000Z"
  };
}

async function writeGiteaRecord(fixture: Fixture, port: number): Promise<void> {
  await writeFile(fixture.giteaPath, `${JSON.stringify({
    schemaVersion: 2,
    serviceId: "S".repeat(43),
    containerOwnershipId: "C".repeat(43),
    networkOwnershipId: "N".repeat(43),
    volumeOwnershipId: "V".repeat(43),
    phase: "ready",
    containerName: "dim-gitea",
    networkName: "dim-control",
    volumeName: "dim-gitea-data",
    image: "gitea/gitea:1.27.0",
    imageId: `sha256:${"a".repeat(64)}`,
    networkId: "b".repeat(64),
    resourcesEstablished: true,
    port,
    endpointAddress: "172.20.0.2",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z"
  }, null, 2)}\n`);
}

function containerInspect(): string {
  return ["existing-gitea-id", "true", "dim", "S".repeat(43), "gitea", "C".repeat(43), "true", "172.20.0.2",
    "b".repeat(64), `sha256:${"a".repeat(64)}`, "volume", "dim-gitea-data", "true"].join("|");
}

function networkInspect(): string { return ["b".repeat(64), "true", "dim", "S".repeat(43), "network", "N".repeat(43)].join("|"); }

function volumeInspect(): string { return ["true", "dim", "S".repeat(43), "gitea-data", "V".repeat(43)].join("|"); }

async function installPlugin(fixture: Fixture, name: string, requireDockerCall = false): Promise<void> {
  const directory = path.join(fixture.pluginHome, "node_modules", name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(fixture.pluginHome, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: [name] }));
  await writeFile(path.join(fixture.pluginHome, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, type: "module", exports: "./index.js" }));
  await writeFile(path.join(directory, "index.js"), requireDockerCall
    ? `import { existsSync, writeFileSync } from "node:fs";
if (!existsSync(${JSON.stringify(fixture.dockerCalls)})) throw new Error("plugin loaded before reconciliation");
writeFileSync(${JSON.stringify(fixture.pluginMarker)}, "loaded");
export const plugin = { name: ${JSON.stringify(name)}, apiVersion: 4, register() {} };\n`
    : `throw new Error("fixture plugin reached");\n`);
}

async function installDocker(fixture: Fixture, body: string): Promise<void> {
  const bin = path.join(fixture.root, "bin");
  await mkdir(bin);
  const target = path.join(bin, "docker");
  await writeFile(target, `#!/bin/sh\n${body}\n`);
  await chmod(target, 0o755);
}

function controllerArguments(fixture: Fixture): string[] {
  return ["controller", "serve", "--socket", fixture.socket, "--admin-socket", fixture.adminSocket,
    "--agent-socket", fixture.agentSocket, "--pid-file", fixture.pidPath];
}

function runController(fixture: Fixture) {
  return spawnSync("flock", ["--shared", buildLock, process.execPath, cli, ...controllerArguments(fixture)], {
    cwd: packageDirectory,
    encoding: "utf8",
    env: fixture.environment
  });
}

function runSourceController(fixture: Fixture) {
  return spawnSync(process.execPath, ["--import", tsxImport, sourceCli, ...controllerArguments(fixture)], {
    cwd: packageDirectory,
    encoding: "utf8",
    env: fixture.environment
  });
}

function spawnController(fixture: Fixture) {
  return spawn("flock", ["--shared", buildLock, process.execPath, cli, ...controllerArguments(fixture)], {
    cwd: packageDirectory,
    env: fixture.environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function stopController(controller: ReturnType<typeof spawn>, pidPath: string): Promise<void> {
  if (controller.exitCode !== null) return;
  const exited = once(controller, "exit");
  try {
    process.kill(Number((await readFile(pidPath, "utf8")).trim()), "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    controller.kill("SIGTERM");
  }
  await exited;
}

async function assertRuntimeMissing(fixture: Fixture): Promise<void> {
  await Promise.all([
    assertMissing(fixture.socket), assertMissing(fixture.adminSocket), assertMissing(fixture.agentSocket),
    assertMissing(fixture.pidPath)
  ]);
}

async function assertMissing(target: string): Promise<void> {
  await assert.rejects(access(target), { code: "ENOENT" });
}

async function waitForPath(target: string): Promise<void> {
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    try {
      await access(target);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for ${target}`);
}
