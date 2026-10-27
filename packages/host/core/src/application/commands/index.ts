import { Command, CommanderError } from "commander";
import { UserError } from "../../errors.js";
import { packageVersion } from "../../package-version.js";

/** The selected host owns its commands, options, help and output. None of this
 * parser is imported by the independently installed transport CLI. */
export async function runHostCommand(args: readonly string[]): Promise<void> {
  if (args[0] === "controller") {
    const { runControllerApplication } = await import("./controller.js");
    await runControllerApplication([...args]); return;
  }
  if (args[0] === "control-plane") {
    const { runControlPlaneApplication } = await import("./control-plane.js");
    await runControlPlaneApplication([...args]); return;
  }
  const program = new Command().name("dim").description("Persistent, isolated development workspaces")
    .version(packageVersion).showSuggestionAfterError().configureHelp({ sortSubcommands: true, sortOptions: true });
  const { registerDevelopmentCommands } = await import("./workspaces.js");
  registerDevelopmentCommands(program);
  program.command("controller").description("Manage this host controller");
  program.command("control-plane").description("Optional control-plane deployment and operator commands");
  if (args[0] && !args[0].startsWith("-") && !program.commands.some((command) => command.name() === args[0] || command.aliases().includes(args[0]!))) {
    const { executeHostOperation } = await import("../host-application.js");
    await executeHostOperation({ operation: "plugin.cli", input: { args: [...args] } });
    return;
  }
  if (!args.length || args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    const { executeHostOperation } = await import("../host-application.js");
    const plugins = await executeHostOperation({ operation: "plugins" });
    if (!Array.isArray(plugins)) throw new UserError("Invalid installed host command catalog");
    const commands = plugins.flatMap((plugin: { commands?: readonly { name: string; description: string }[] }) => plugin.commands ?? []);
    if (commands.length) program.addHelpText("after", `\nInstalled host commands:\n${commands.map(({ name, description }) => `  ${name}\t${description}`).join("\n")}`);
    program.addHelpText("after", "\nClient commands: dim host --help; dim forward --help");
  }
  program.exitOverride();
  try { await program.parseAsync([...args], { from: "user" }); }
  catch (error) {
    if (error instanceof CommanderError) {
      if (!["commander.helpDisplayed", "commander.version"].includes(error.code)) process.exitCode = error.exitCode || 2;
      return;
    }
    throw error;
  }
}
