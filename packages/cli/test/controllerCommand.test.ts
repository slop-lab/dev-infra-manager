import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../../../../core/packages/cli/src/cli.ts", import.meta.url));
const packageDirectory = fileURLToPath(new URL("../../../../core/packages/cli", import.meta.url));
const tsxImport = import.meta.resolve("tsx");

test("controller serve preserves the active owner and cleans up its runtime files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-controller-test-"));
  const socket = path.join(root, "controller.sock");
  const adminSocket = path.join(root, "admin.sock");
  const agentSocket = path.join(root, "agent.sock");
  const pidPath = path.join(root, "controller.pid");
  const configHome = path.join(root, "config");
  await mkdir(path.join(configHome, "dim"), { recursive: true });
  await writeFile(
    path.join(configHome, "dim", "config.json"),
    `${JSON.stringify({ schemaVersion: 1, workspaceBackend: "sysbox" })}\n`
  );
  const args = [
    "--import", tsxImport, cli, "controller", "serve", "--socket", socket,
    "--admin-socket", adminSocket, "--agent-socket", agentSocket
  ];
  const env = {
    ...process.env,
    DIM_ADMIN_CONTROLLER_SOCKET: adminSocket,
    DIM_AGENT_CONTROLLER_SOCKET: agentSocket,
    DIM_CONTROLLER_SOCKET: socket,
    DIM_PLUGIN_HOME: path.join(root, "plugins"),
    DIM_STATE_ROOT: path.join(root, "state"),
    XDG_CONFIG_HOME: configHome
  };
  const controller = spawn(process.execPath, args, {
    cwd: packageDirectory,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForPath(pidPath);
    assert.equal(Number((await readFile(pidPath, "utf8")).trim()), controller.pid);
    const duplicate = spawn(process.execPath, args, {
      cwd: packageDirectory,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const [code] = await Promise.race([
      once(duplicate, "exit"),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("duplicate controller did not exit")), 5_000))
    ]);
    assert.equal(code, 2);
    assert.equal(Number((await readFile(pidPath, "utf8")).trim()), controller.pid);
  } finally {
    if (controller.exitCode === null) {
      controller.kill("SIGTERM");
      await once(controller, "exit");
    }
  }
  try {
    await assert.rejects(access(pidPath), { code: "ENOENT" });
    await assert.rejects(access(socket), { code: "ENOENT" });
    await assert.rejects(access(agentSocket), { code: "ENOENT" });
    await assert.rejects(access(adminSocket), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("controller serve identifies plugin route initialization as the failing startup stage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-controller-plugin-stage-"));
  const pluginHome = path.join(root, "plugins");
  const pluginDirectory = path.join(pluginHome, "node_modules", "test-ingress-plugin");
  const configHome = path.join(root, "config");
  await mkdir(pluginDirectory, { recursive: true });
  await mkdir(path.join(configHome, "dim"), { recursive: true });
  await writeFile(
    path.join(configHome, "dim", "config.json"),
    `${JSON.stringify({ schemaVersion: 1, workspaceBackend: "sysbox" })}\n`
  );
  await writeFile(path.join(pluginHome, "plugins.json"), JSON.stringify({
    schemaVersion: 1,
    plugins: ["test-ingress-plugin"]
  }));
  await writeFile(path.join(pluginHome, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(pluginDirectory, "package.json"), JSON.stringify({
    name: "test-ingress-plugin",
    type: "module",
    exports: "./index.js"
  }));
  await writeFile(path.join(pluginDirectory, "index.js"), `export const plugin = {
  name: "test-ingress-plugin",
  apiVersion: 4,
  register(host) {
    host.registerControllerRoute({
      method: "GET",
      path: "/test-ingress",
      audiences: ["workspace"],
      initialize() { throw new Error("ingress startup refused") },
      handle() {}
    })
  }
}
`);
  try {
    const result = spawnSync(process.execPath, [
      "--import", tsxImport, cli, "controller", "serve",
      "--socket", path.join(root, "controller.sock"),
      "--admin-socket", path.join(root, "admin.sock"),
      "--agent-socket", path.join(root, "agent.sock"),
      "--pid-file", path.join(root, "controller.pid")
    ], {
      cwd: packageDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        DIM_CONFIG_PATH: path.join(configHome, "dim", "config.json"),
        DIM_PLUGIN_HOME: pluginHome,
        DIM_STATE_ROOT: path.join(root, "state"),
        XDG_CONFIG_HOME: configHome
      }
    });

    assert.equal(result.status, 2);
    assert.equal(
      result.stderr,
      "controller startup failed while initializing plugin routes: ingress startup refused\n"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForPath(target: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
