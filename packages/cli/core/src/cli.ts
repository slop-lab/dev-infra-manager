#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { UserError } from "@slop-lab/dim-host-core/workspace";
import { HostContextError, HostContextStore } from "./host-context.js";
import { packageVersion } from "./package-version.js";
import { HostTransportError, streamHost } from "./host-transport.js";
import { registerDevelopmentCommands } from "./development-commands.js";

await main();

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(process.argv[2] === "--" ? 3 : 2);
    if (args[0] === "__agent") {
      if (args.length !== 2) throw new UserError("workspace bridge requires exactly one private configuration path");
      const { runWorkspaceAgent } = await import("./workspace-agent.js");
      await runWorkspaceAgent(args[1]!); return;
    }
    if (args[0] === "__host") {
      if (args.length !== 2) throw new UserError("host mode requires exactly one encoded request");
      const { runHostRequest } = await import("./host-application.js");
      await runHostRequest(args[1]!);
      return;
    }
    // Optional administration follows the selected host. The root controller
    // alias without an explicit host remains local for installer activation/recovery.
    const { args: commandArgs, host: selectedHost } = hostArguments(args);
    if (commandArgs[0] === "control-plane" || (commandArgs[0] === "controller" && selectedHost !== undefined)) {
      const host = await new HostContextStore().resolve(selectedHost);
      if (host.ssh !== undefined) {
        const abort = new AbortController();
        const stop = () => abort.abort();
        process.once("SIGINT", stop); process.once("SIGTERM", stop); process.once("SIGHUP", stop);
        try {
          process.exitCode = await streamHost(host, { operation: commandArgs[0] === "controller" ? "controller.cli" : "controlPlane.cli", input: { args: commandArgs } }, {
            signal: abort.signal, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY)
          });
        } finally {
          process.off("SIGINT", stop); process.off("SIGTERM", stop); process.off("SIGHUP", stop);
        }
      } else {
        if (commandArgs[0] === "controller") {
          const { runControllerApplication } = await import("./controller-application.js");
          await runControllerApplication(commandArgs);
        } else {
          const { runControlPlaneApplication } = await import("./control-plane-application.js");
          await runControlPlaneApplication(commandArgs);
        }
      }
      return;
    }
    if (commandArgs[0] === "controller") {
      const { runControllerApplication } = await import("./controller-application.js");
      await runControllerApplication(commandArgs);
      return;
    }
    const program = new Command()
      .name("dim")
      .description("Persistent, isolated local and remote development workspaces")
      .version(packageVersion)
      .option("--host <name>", "use a configured development host")
      .showSuggestionAfterError()
      .configureHelp({ sortSubcommands: true, sortOptions: true });
    registerDevelopmentCommands(program);
    program.command("control-plane").description("Optional control-plane deployment and operator commands");
    program.command("controller").description("Manage the host controller (local unless --host is explicit)");
    // Unknown top-level commands are resolved on the selected host, where optional
    // integrations are installed. A base-only remote client loads none of them.
    if (commandArgs[0] && !commandArgs[0].startsWith("-")
      && !program.commands.some((command) => command.name() === commandArgs[0] || command.aliases().includes(commandArgs[0]!))) {
      const target = await new HostContextStore().resolve(selectedHost);
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once("SIGINT", stop); process.once("SIGTERM", stop); process.once("SIGHUP", stop);
      try {
        process.exitCode = await streamHost(target, { operation: "plugin.cli", input: { args: commandArgs } }, {
          signal: abort.signal, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY)
        });
      } finally {
        process.off("SIGINT", stop); process.off("SIGTERM", stop); process.off("SIGHUP", stop);
      }
      return;
    }
    program.addHelpText("after", `
Start developing:
  dim create https://example.com/team/app.git dev
  dim ls
  dim shell dev

Use 'dim host --help' for SSH hosts and 'dim control-plane --help' for optional control-plane administration.
${process.env.DIM_INVOKED_VIA_INSTALLER === "1" ? "\nInstaller: dim installer install core|plugin|control-plane" : ""}`);
    program.exitOverride();
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return;
      process.exitCode = error.exitCode || 2; return;
    }
    if (error instanceof HostTransportError) {
      if (!error.reported) console.error(error.message);
      process.exitCode = error.exitCode; return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof UserError && /^workspace (?:create|start|stop|restart|recreate|resources|discard) '/.test(error.message)) {
      console.error("Run 'dim doctor' on the selected host to check runtime prerequisites.");
    }
    process.exitCode = error instanceof UserError || error instanceof HostContextError ? 2 : 1;
  }
}

/** Match Commander global options without consuming command arguments after `--`. */
function hostArguments(args: string[]): { args: string[]; host?: string } {
  const remaining: string[] = [];
  let host: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--") { remaining.push(...args.slice(index)); break; }
    if (argument === "--host") {
      const value = args[++index];
      if (value === undefined || value.startsWith("-")) throw new UserError("option '--host <name>' argument missing");
      host = value;
    } else if (argument.startsWith("--host=")) {
      host = argument.slice("--host=".length);
      if (!host) throw new UserError("option '--host <name>' argument missing");
    } else remaining.push(argument);
  }
  return { args: remaining, ...(host === undefined ? {} : { host }) };
}
