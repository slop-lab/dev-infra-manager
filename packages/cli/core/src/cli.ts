#!/usr/bin/env node
import { Writable } from "node:stream";
import { Command, CommanderError } from "commander";
import { UserError } from "@slop-lab/dim-host-core/workspace";
import { HostContextError, HostContextStore } from "./host-context.js";
import { packageVersion } from "./package-version.js";
import { HostTransportError, callHost, streamHost } from "./host-transport.js";
import { registerDevelopmentCommands } from "./development-commands.js";

await main();

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(process.argv[2] === "--" ? 3 : 2);
    if (args[0] === "__host") {
      if (args.length !== 2) throw new UserError("host mode requires exactly one encoded request");
      const { runHostRequest } = await import("@slop-lab/dim-host-core/application");
      await runHostRequest(args[1]!, {
        controller: async (command) => { const { runControllerApplication } = await import("./controller-application.js"); await runControllerApplication(command); },
        controlPlane: async (command) => { const { runControlPlaneApplication } = await import("./control-plane-application.js"); await runControlPlaneApplication(command); }
      });
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
    if (commandArgs.length === 0 || commandArgs.length === 1 && ["--help", "-h"].includes(commandArgs[0]!)) {
      const optionalHelp = await installedCommandHelp(program, selectedHost);
      if (optionalHelp) program.addHelpText("after", optionalHelp);
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

/** Query descriptions on the selected host; feature code stays in host composition. */
async function installedCommandHelp(program: Command, selectedHost: string | undefined): Promise<string> {
  try {
    const host = await new HostContextStore().resolve(selectedHost);
    const quiet = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const metadata: unknown = await callHost(host, { operation: "plugins" }, { signal: AbortSignal.timeout(1_000), stderr: quiet, maxOutputBytes: 128 * 1024 });
    if (!Array.isArray(metadata) || metadata.length > 128) return "";
    const reserved = new Set(program.commands.flatMap((command) => [command.name(), ...command.aliases()]));
    const entries: Array<{ name: string; description: string }> = [];
    const names = new Set<string>();
    const identifier = /^[a-z][a-z0-9-]{0,63}$/;
    const printable = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum
      && !/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u.test(value);
    const plugins: unknown[] = metadata;
    for (const plugin of plugins) {
      if (!plugin || typeof plugin !== "object" || !("name" in plugin) || typeof plugin.name !== "string" || !identifier.test(plugin.name)
        || !("commands" in plugin) || !Array.isArray(plugin.commands) || plugin.commands.length > 64) return "";
      const commands: unknown[] = plugin.commands;
      for (const command of commands) {
        if (!command || typeof command !== "object" || !("name" in command) || typeof command.name !== "string" || !identifier.test(command.name)
          || !("description" in command) || !printable(command.description, 256) || names.has(command.name)) return "";
        names.add(command.name);
        if (!reserved.has(command.name)) entries.push({ name: command.name, description: command.description });
      }
    }
    if (!entries.length) return "";
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const width = Math.max(...entries.map((entry) => entry.name.length));
    return `\nOptional commands on host '${host.name}':\n${entries.map((entry) => `  ${entry.name.padEnd(width)}  ${entry.description}`).join("\n")}\n\nUse 'dim COMMAND --help' for an optional command's options.\n`;
  } catch { return ""; } // Base help remains available when optional host discovery fails.
}
