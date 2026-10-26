import { once } from "node:events";
import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { controllerRequest } from "./controller-client.js";
import { controllerWorkspaceStateRoot, type ControllerWorkspaceMetadataResolver } from "../controllerWorkspace.js";
import { UserError, ProcessRunner } from "@slop-lab/dim-host-core";
import { composeWorkspaceRuntime } from "../../application/host-plugins.js";
import {
  ADMIN_CONTROLLER_STOP_EVENT, configuredDimAdminController, configuredDimController,
  initializeControllerRoutes, lifecycleOptions, loadInstalledPlugins,
  resolvePluginHome
} from "../index.js";
import {
  claimControllerPid, pidFileOwnedByCurrentProcess,
  prepareControllerSocket, restartManagedController, stopManagedController
} from "./managed-controller.js";
import {
  closeControllerServers,
  disposeControllerPlugins
} from "./controller-teardown.js";

const runner = new ProcessRunner();

export function registerControllerCommands(program: Command, metadata?: ControllerWorkspaceMetadataResolver): void {
  const controller = program.command("controller").description("Run trusted DIM controller services");
  controller.command("host-input").description("Read an allowed host setting").command("get")
    .argument("<provider>").argument("<key>").option("--workspace <name>")
    .option("--parameters <parameters>")
    .action(async (provider: string, key: string, flags: { workspace?: string; parameters?: string }) => {
      const result: unknown = await controllerRequest(`/api/host-inputs/${encodeURIComponent(provider)}`, {
        method: "POST", body: JSON.stringify({ key, ...(flags.parameters === undefined ? {} : { parameters: flags.parameters }) })
      }, flags.workspace);
      if (!result || typeof result !== "object" || !("value" in result) || typeof result.value !== "string")
        throw new UserError("host input provider returned an invalid value");
      process.stdout.write(`${result.value}\n`);
    });
controller.command("restart")
  .description("Restart the managed controller and reload installed plugins and ingress configuration")
  .action(async () => {
    const options = lifecycleOptions();

    await restartManagedController(options);
    console.log(`Restarted managed DIM controller at ${options.controllerSocketPath}`);
  });

controller.command("stop")
  .description("Stop the owned managed controller")
  .action(async () => {
    await stopManagedController(lifecycleOptions());
  });

controller.command("serve")
  .description("Serve optional host-admin and workspace plugin APIs")
  .option("--socket <path>", "listen on a Unix socket")
  .option("--admin-socket <path>", "listen for host administration on a Unix socket")
  .option("--pid-file <path>", "record the managed controller process ID")
  .option("--host <host>", "listen address for explicit TCP mode")
  .option("--port <port>", "listen port for explicit TCP mode")
  .action(async (flags: { socket?: string; adminSocket?: string; pidFile?: string; host?: string; port?: string }) => {
    if (flags.socket && (flags.host || flags.port)) {
      throw new UserError("--socket cannot be combined with --host or --port");
    }
    if (!flags.socket && (!flags.host || !flags.port)) {
      throw new UserError("controller serve requires --socket, or both --host and --port");
    }
    const options = lifecycleOptions();

    const adminSocket = flags.socket
      ? flags.adminSocket ?? options.adminControllerSocketPath
      : undefined;
    const pidPath = flags.socket
      ? flags.pidFile ?? path.join(path.dirname(flags.socket), "controller.pid")
      : undefined;
    let ownsPid = false;
    let loaded: Awaited<ReturnType<typeof loadInstalledPlugins>> | undefined;
    let server: ReturnType<typeof configuredDimController> | undefined;
    let adminServer: ReturnType<typeof configuredDimAdminController> | undefined;
    let shutdownReached = false;
    try {
      if (pidPath) {
        await mkdir(path.dirname(pidPath), { recursive: true });
        await claimControllerPid(pidPath);
        ownsPid = true;
      }
      const loadedPlugins = await controllerStartupStage(
        "loading plugins",
        async () => await loadInstalledPlugins(await resolvePluginHome())
      );
      loaded = loadedPlugins;
      const workspaceRuntime = composeWorkspaceRuntime({
        runner,
        cleanupRunner: runner,
        stateRoot: controllerWorkspaceStateRoot()
      }).runtime;
      const controllerOptions = { ...options, workspaceRuntime };
      await controllerStartupStage(
        "initializing plugin routes",
        async () => await initializeControllerRoutes(controllerOptions, loadedPlugins.registered, runner, metadata)
      );
      server = configuredDimController(controllerOptions, loaded.registered, metadata);
      adminServer = configuredDimAdminController(options, loaded.registered, runner);
      const stopRequested = once(adminServer, ADMIN_CONTROLLER_STOP_EVENT);
      if (flags.socket && adminSocket) {
        await prepareControllerSocket(flags.socket);
        const workspaceListening = once(server, "listening");
        server.listen(flags.socket);
        await workspaceListening;
        await prepareControllerSocket(adminSocket);
        const adminListening = once(adminServer, "listening");
        adminServer.listen(adminSocket);
        await adminListening;
        await chmod(adminSocket, 0o600);
        await chmod(flags.socket, 0o600);
        console.log(`DIM workspace controller listening on ${flags.socket}`);
        console.log(`DIM admin controller listening on ${adminSocket}`);
      } else {
        const port = Number(flags.port);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
          throw new UserError("--port must be between 1 and 65535");
        }
        const listening = once(server, "listening");
        server.listen(port, flags.host);
        await listening;
        console.log(`DIM controller listening on http://${flags.host}:${flags.port}`);
      }
      await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM"), stopRequested]);
      shutdownReached = true;
    } finally {
      let cleanupError: unknown;
      try {
        await closeControllerServers([server, adminServer]);
        if (!await disposeControllerPlugins(loaded?.registered)) {
          cleanupError ??= new UserError("controller plugins did not dispose within the shutdown deadline");
        }
      } catch (error) {
        cleanupError = error;
      } finally {
        if (ownsPid && pidPath && await pidFileOwnedByCurrentProcess(pidPath)) {
          if (flags.socket) await rm(flags.socket, { force: true });
          if (adminSocket) await rm(adminSocket, { force: true });
          await rm(pidPath, { force: true });
        }
      }
      if (shutdownReached) {
        if (cleanupError !== undefined) console.error(cleanupError);
        process.exit(cleanupError === undefined ? 0 : 1);
      }
      if (cleanupError !== undefined) throw cleanupError;
    }
  });
}

async function controllerStartupStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UserError(`controller startup failed while ${stage}: ${detail}`);
  }
}

export async function runControllerCli(args: readonly string[], metadata?: ControllerWorkspaceMetadataResolver): Promise<void> {
  const program = new Command().name("dim").exitOverride();
  registerControllerCommands(program, metadata);
  await program.parseAsync([...args], { from: "user" });
}
