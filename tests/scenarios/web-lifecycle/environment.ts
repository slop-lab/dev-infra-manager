import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { lifecycleOptions } from "../../../packages/host/core/src/controller/lifecycleOptions.js";
import { initializeOperationsWeb } from "../../../packages/web/core/src/initialize.js";
import { createWebServerFromConfigFile, type WebServer } from "../../../packages/web/core/src/server.js";
import { gitHttpFixture, type GitHttpFixture } from "../../support/gitHttpFixture.js";
import { runCommand, type CommandResult } from "./process.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const portableSocketRootPrefix = "dwl-";

export type LifecycleEnvironment = {
  readonly root: string;
  readonly name: string;
  readonly origin: string;
  readonly controllerPidPath: string;
  readonly username: string;
  readonly password: string;
  readonly page: Page;
  readonly repositoryUrl: string;
  cli(arguments_: readonly string[], acceptFailure?: boolean): Promise<CommandResult>;
  close(options?: { readonly removeRoot?: boolean }): Promise<void>;
};

export class EnvironmentCleanupError extends Error {
  readonly name = "EnvironmentCleanupError";
  constructor(readonly evidenceRoot: string, options?: ErrorOptions) {
    super("private fixture shutdown failed; evidence retained", options);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("expected TCP port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

export async function writeExecutables(root: string): Promise<{ readonly cli: string; readonly env: NodeJS.ProcessEnv }> {
  const privateHome = path.join(root, "home");
  const stateRoot = path.join(root, "state");
  const pluginHome = path.join(root, "plugins");
  const configHome = path.join(root, "config");
  const stateHome = path.join(root, "xdg-state");
  const runtimeHome = path.join(root, "runtime");
  const managedState = path.join(root, "managed-state");
  await Promise.all([privateHome, stateRoot, pluginHome, configHome, stateHome, runtimeHome, managedState].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  const hostEntry = path.join(repositoryRoot, "packages/host/core/dist/application/host-main.js");
  const cliEntry = path.join(repositoryRoot, "packages/cli/core/dist/cli.js");
  const host = path.join(root, "dim-host-built");
  const cli = path.join(root, "dim-built");
  await writeFile(host, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(hostEntry)} "$@"\n`, { mode: 0o700 });
  const values = {
    HOME: privateHome,
    DIM_STATE_ROOT: stateRoot,
    DIM_PLUGIN_HOME: pluginHome,
    DIM_MANAGED_STATE_ROOT: managedState,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateHome,
    XDG_RUNTIME_DIR: runtimeHome,
    DIM_CONTROLLER_SOCKET: path.join(root, "controller.sock"),
    DIM_ADMIN_CONTROLLER_SOCKET: path.join(root, "admin.sock"),
    DIM_HOST_EXECUTABLE: host
  };
  const exports = Object.entries(values).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n");
  await writeFile(cli, `#!/bin/sh\n${exports}\nexec ${shellQuote(process.execPath)} ${shellQuote(cliEntry)} "$@"\n`, { mode: 0o700 });
  await chmod(cli, 0o700);
  return { cli, env: { ...process.env, ...values } };
}

export async function createLifecycleEnvironment(chromiumPath: string): Promise<LifecycleEnvironment> {
  const root = await mkdtemp(path.join(tmpdir(), portableSocketRootPrefix));
  let git: GitHttpFixture | undefined;
  let web: WebServer | undefined;
  let browser: Browser | undefined;
  try {
    const executable = await writeExecutables(root);
    git = await gitHttpFixture();
    const operations = path.join(root, "operations.json");
    const config = path.join(root, "web.json");
    await writeFile(operations, JSON.stringify({ hosts: [{ id: "fixture", selector: "local", executable: executable.cli }], consoles: [] }), { mode: 0o600 });
    const initialized = await initializeOperationsWeb({ operations, output: config, port: await reservePort() });
    web = await createWebServerFromConfigFile(config);
    const origin = await web.listen();
    browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(30_000);
    const page = await context.newPage();
    const name = `web-daily-${randomUUID().slice(0, 12)}`;
    return {
      root,
      name,
      origin,
      controllerPidPath: path.join(lifecycleOptions(executable.env).controllerRuntimeDirectory, "controller.pid"),
      username: initialized.username,
      password: initialized.password,
      page,
      repositoryUrl: git.url("project-a", "source"),
      cli: (arguments_, acceptFailure = false) => runCommand(executable.cli, ["--host", "local", ...arguments_], { acceptFailure, env: executable.env, timeoutMs: 360_000 }),
      async close(options = {}) {
        const errors: unknown[] = [];
        for (const close of [() => browser?.close(), () => web?.close(), () => git?.close()]) {
          try { await close(); } catch (error) { errors.push(error); }
        }
        try {
          const stopped = await runCommand(executable.cli, ["--host", "local", "controller", "stop"], {
            acceptFailure: true, env: executable.env, timeoutMs: 30_000
          });
          if (stopped.exitCode !== 0) errors.push(new TypeError("owned private controller did not stop"));
        } catch (error) { errors.push(error); }
        if (errors.length > 0) throw new EnvironmentCleanupError(root, { cause: new AggregateError(errors) });
        if (options.removeRoot !== false) await rm(root, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await browser?.close();
    await web?.close();
    await git?.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
