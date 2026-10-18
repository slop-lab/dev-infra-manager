#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { packageVersion } from "./package-version.js";
import { HostTransportError } from "./host-transport.js";
import { registerDevelopmentCommands } from "./development-commands.js";

await main();

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(process.argv[2] === "--" ? 3 : 2);
    if (args[0] === "__host") {
      if (args.length !== 2) throw new Error("host mode requires exactly one encoded request");
      const { runHostRequest } = await import("./host-application.js");
      await runHostRequest(args[1]!);
      return;
    }
    // Optional administration is loaded only when selected. The installer uses
    // controller restart, so that facade integration remains directly reachable.
    if (args[0] === "managed" || ["controller", "plugin", "ci", "external-url", "project", "host-input", "x"].includes(args[0] ?? "")) {
      try {
        import.meta.resolve("@slop-lab/dim-managed/cli");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
          throw new Error("Managed administration is not installed. Run 'dim installer install core --with-managed' to add it.");
        }
        throw error;
      }
      const { runManagedCli } = await import("@slop-lab/dim-managed/cli");
      await runManagedCli(args[0] === "managed" ? args.slice(1) : args);
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
    program.command("managed").description("Optional managed Git, review, CI and host administration");
    program.command("controller").description("Manage the optional host controller");
    program.addHelpText("after", `
Start developing:
  dim create https://example.com/team/app.git dev
  dim ls
  dim shell dev

Use 'dim host --help' for SSH hosts and 'dim managed --help' for managed services.
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
    process.exitCode = 2;
  }
}
