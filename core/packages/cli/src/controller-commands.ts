import { once } from "node:events";
import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { type Command } from "commander";
import {
  configuredDimAdminController, configuredDimAgentController, configuredDimController,
  initializeControllerRoutes, LifecycleState, lifecycleOptions, loadInstalledPlugins,
  migrateHostLifecycleState, reconcileReadyHostManagedGit, requireHostMirrorProvider, resolveHostMirrorProvider,
  resolvePluginHome, UserError
} from "@slop-lab/dim-core";
import {
  claimControllerPid, closeControllerServer, pidFileOwnedByCurrentProcess,
  prepareControllerSocket, restartManagedController, runner
} from "./cli-support.js";

export function registerControllerCommands(program: Command): void {
  const controller = program.command("controller").description("Run trusted DIM controller services");
controller.command("restart")
  .description("Restart the managed controller and reload installed plugins and ingress configuration")
  .action(async () => {
    const options = lifecycleOptions();
    await restartManagedController(options);
    console.log(`Restarted managed DIM controller at ${options.controllerSocketPath}`);
  });

controller.command("serve")
  .description("Serve host-admin and trusted-workspace controller APIs")
  .option("--socket <path>", "listen on a Unix socket")
  .option("--admin-socket <path>", "listen for host administration on a Unix socket")
  .option("--agent-socket <path>", "listen for agent-safe workspace APIs on a Unix socket")
  .option("--pid-file <path>", "record the managed controller process ID")
  .option("--host <host>", "listen address for explicit TCP mode")
  .option("--port <port>", "listen port for explicit TCP mode")
  .action(async (flags: { socket?: string; adminSocket?: string; agentSocket?: string; pidFile?: string; host?: string; port?: string }) => {
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
    const agentSocket = flags.socket
      ? flags.agentSocket ?? options.agentControllerSocketPath
      : undefined;
    const pidPath = flags.socket
      ? flags.pidFile ?? path.join(path.dirname(flags.socket), "controller.pid")
      : undefined;
    let ownsPid = false;
    let loaded: Awaited<ReturnType<typeof loadInstalledPlugins>> | undefined;
    let server: ReturnType<typeof configuredDimController> | undefined;
    let adminServer: ReturnType<typeof configuredDimAdminController> | undefined;
    let agentServer: ReturnType<typeof configuredDimAgentController> | undefined;
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
      const hostMirrorProvider = await controllerStartupStage(
        "resolving host mirror provider",
        async () => requireHostMirrorProvider(resolveHostMirrorProvider(loadedPlugins.registered.host))
      );
      const runtimeOptions = { ...options, hostMirrorProvider };
      const migration = await controllerStartupStage(
        "migrating host lifecycle state",
        async () => await migrateHostLifecycleState(new LifecycleState(options.stateRoot))
      );
      if (migration.kind === "migrated") {
        console.log("Migrated host lifecycle state schema 1 to 2");
      } else if (migration.kind === "recovered") {
        console.log("Recovered host lifecycle state schema 2 from the schema 1 backup");
      }
      await controllerStartupStage("reconciling managed Git service", async () => {
        await reconcileReadyHostManagedGit(runner, options);
      });
      await controllerStartupStage(
        "initializing plugin routes",
        async () => await initializeControllerRoutes(runtimeOptions, loadedPlugins.registered)
      );
      server = configuredDimController(runtimeOptions, loaded.registered);
      adminServer = configuredDimAdminController(runtimeOptions, loaded.registered);
      agentServer = configuredDimAgentController(runtimeOptions, loaded.registered);
      if (flags.socket && adminSocket && agentSocket) {
        await prepareControllerSocket(flags.socket);
        const workspaceListening = once(server, "listening");
        server.listen(flags.socket);
        await workspaceListening;
        await prepareControllerSocket(adminSocket);
        const adminListening = once(adminServer, "listening");
        adminServer.listen(adminSocket);
        await adminListening;
        await chmod(adminSocket, 0o600);
        await chmod(flags.socket, 0o666);
        await prepareControllerSocket(agentSocket);
        const agentListening = once(agentServer, "listening");
        agentServer.listen(agentSocket);
        await agentListening;
        await chmod(agentSocket, 0o666);
        console.log(`DIM workspace controller listening on ${flags.socket}`);
        console.log(`DIM agent controller listening on ${agentSocket}`);
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
      await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
    } finally {
      try {
        await loaded?.registered.dispose();
      } finally {
        try {
          await Promise.all([
            closeControllerServer(server),
            closeControllerServer(agentServer),
            closeControllerServer(adminServer)
          ]);
        } finally {
          if (ownsPid && pidPath && await pidFileOwnedByCurrentProcess(pidPath)) {
            if (flags.socket) await rm(flags.socket, { force: true });
            if (agentSocket) await rm(agentSocket, { force: true });
            if (adminSocket) await rm(adminSocket, { force: true });
            await rm(pidPath, { force: true });
          }
        }
      }
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
