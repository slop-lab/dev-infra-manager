import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../../packages/cli/core/dist/cli.js", import.meta.url));
const packageDirectory = fileURLToPath(new URL("../../packages/cli/core", import.meta.url));

test("controller serve preserves the active owner and cleans up its runtime files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-controller-test-"));
  const socket = path.join(root, "controller.sock");
  const adminSocket = path.join(root, "admin.sock");
  const pidPath = path.join(root, "controller.pid");
  const configHome = path.join(root, "config");
  const pluginHome = path.join(root, "plugins");
  await mkdir(path.join(configHome, "dim"), { recursive: true });
  await writeFile(
    path.join(configHome, "dim", "config.json"),
    `${JSON.stringify({ schemaVersion: 1, workspaceBackend: "sysbox" })}\n`
  );
  await installProviderPlugin(pluginHome);
  const args = [
    cli, "controller", "serve", "--socket", socket,
    "--admin-socket", adminSocket
  ];
  const env = {
    ...process.env,
    DIM_ADMIN_CONTROLLER_SOCKET: adminSocket,
    DIM_CONTROLLER_SOCKET: socket,
    DIM_PLUGIN_HOME: pluginHome,
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
    await assert.rejects(access(adminSocket), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("controller stop never signals an unrelated process with controller-looking argv", async () => {
  // Given
  const root = await mkdtemp(path.join(tmpdir(), "dim-controller-stop-owner-"));
  const runtimeRoot = path.join(root, "runtime");
  const controllerRuntime = path.join(runtimeRoot, "dim", "managed");
  const configHome = path.join(root, "config");
  await mkdir(controllerRuntime, { recursive: true });
  await mkdir(path.join(configHome, "dim"), { recursive: true });
  await writeFile(
    path.join(configHome, "dim", "config.json"),
    `${JSON.stringify({ schemaVersion: 1, workspaceBackend: "sysbox" })}\n`
  );
  const pidPath = path.join(controllerRuntime, "controller.pid");
  const unrelated = spawn(process.execPath, [
    "-e", "setInterval(() => {}, 1000)",
    "controller", "serve",
    "--socket", path.join(controllerRuntime, "workspace", "controller.sock"),
    "--admin-socket", path.join(controllerRuntime, "admin", "controller.sock"),
    "--pid-file", pidPath
  ], { stdio: "ignore" });
  if (unrelated.pid === undefined) throw new Error("unrelated process did not start");
  const unrelatedExit = once(unrelated, "exit");
  await writeFile(pidPath, `${unrelated.pid}\n`, { mode: 0o600 });

  try {
    // When
    const result = await runCli(["controller", "stop"], {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: configHome,
      XDG_RUNTIME_DIR: runtimeRoot
    });

    // Then
    assert.equal(result.code, 2);
    assert.equal(unrelated.exitCode, null);
  } finally {
    if (unrelated.exitCode === null) {
      unrelated.kill("SIGTERM");
      await unrelatedExit;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("controller stop terminates with an attacker-held partial workspace request", async () => {
  // Given
  const root = await mkdtemp(path.join(tmpdir(), "dim-controller-stop-self-"));
  const runtimeRoot = path.join(root, "runtime");
  const controllerRuntime = path.join(runtimeRoot, "dim", "managed");
  const configHome = path.join(root, "config");
  const pluginHome = path.join(root, "plugins");
  const socket = path.join(controllerRuntime, "workspace", "controller.sock");
  const adminSocket = path.join(controllerRuntime, "admin", "controller.sock");
  const pidPath = path.join(controllerRuntime, "controller.pid");
  await mkdir(path.join(configHome, "dim"), { recursive: true });
  await writeFile(
    path.join(configHome, "dim", "config.json"),
    `${JSON.stringify({ schemaVersion: 1, workspaceBackend: "sysbox" })}\n`
  );
  await installProviderPlugin(pluginHome);
  const env = {
    ...process.env,
    HOME: root,
    DIM_ADMIN_CONTROLLER_SOCKET: adminSocket,
    DIM_CONTROLLER_SOCKET: socket,
    DIM_PLUGIN_HOME: pluginHome,
    DIM_STATE_ROOT: path.join(root, ".local", "state", "dim", "managed"),
    XDG_CONFIG_HOME: configHome,
    XDG_RUNTIME_DIR: runtimeRoot
  };
  const controller = spawn(process.execPath, [
    cli, "controller", "serve",
    "--socket", socket, "--admin-socket", adminSocket,
    "--pid-file", pidPath
  ], { cwd: packageDirectory, env, stdio: ["ignore", "pipe", "pipe"] });
  const controllerExit = once(controller, "exit");
  let attacker: ReturnType<typeof createConnection> | undefined;

  try {
    await waitForPath(adminSocket);
    attacker = createConnection(socket);
    await once(attacker, "connect");
    attacker.write("GET /healthz HTTP/1.1\r\nHost: dim-controller\r\n");

    // When
    const startedAt = Date.now();
    const result = await runCli(["controller", "stop"], env);

    // Then
    assert.equal(result.code, 0, result.stderr);
    assert.ok(Date.now() - startedAt < 5_000, "controller stop exceeded its teardown budget");
    await Promise.race([
      controllerExit,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("managed controller did not self-terminate")), 5_000))
    ]);
    assert.equal(controller.exitCode, 0);
    await assert.rejects(access(pidPath), { code: "ENOENT" });
    await assert.rejects(access(socket), { code: "ENOENT" });
    await assert.rejects(access(adminSocket), { code: "ENOENT" });
  } finally {
    attacker?.destroy();
    if (controller.exitCode === null) {
      controller.kill("SIGTERM");
      await controllerExit;
    }
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
    host.registerExtension("dim.host-mirror-provider", "host", {
      async ensure() { throw new Error("cache services must not start while initializing controller routes"); }
    });
    host.registerControllerRoute({
      method: "GET",
      path: "/test-ingress",
      initialize() { throw new Error("ingress startup refused") },
      handle() {}
    })
  }
}
`);
  try {
    const result = spawnSync(process.execPath, [
      cli, "controller", "serve",
      "--socket", path.join(root, "controller.sock"),
      "--admin-socket", path.join(root, "admin.sock"),
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

async function installProviderPlugin(pluginHome: string): Promise<void> {
  const name = "test-host-mirror-provider";
  const directory = path.join(pluginHome, "node_modules", name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(pluginHome, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: [name] }));
  await writeFile(path.join(pluginHome, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, type: "module", exports: "./index.js" }));
  await writeFile(path.join(directory, "index.js"), `export const plugin = {
  name: ${JSON.stringify(name)}, apiVersion: 4, register(host) {
    host.registerExtension("dim.host-mirror-provider", "host", {
      async ensure() { throw new Error("cache services must not start while initializing controller routes"); }
    });
  }
};\n`);
}

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

async function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: packageDirectory,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const [code] = await once(child, "exit");
  return { code: typeof code === "number" ? code : null, stdout, stderr };
}
