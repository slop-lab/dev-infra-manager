#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { UserError } from "@slop-lab/dim-core";
import { installerFacadeHelpText } from "./cli-support.js";
import { registerCiCommands } from "./ci-commands.js";
import { registerControllerCommands } from "./controller-commands.js";
import { registerControlPlaneInstallCommand } from "./control-plane-install-command.js";
import { registerDoctorAndPluginCommands } from "./doctor-plugin-commands.js";
import { registerExternalUrlCommands } from "./external-url-commands.js";
import { registerHostIntegrationCommands } from "./host-integration-commands.js";
import { packageVersion } from "./package-version.js";
import { registerProjectCommands } from "./project-commands.js";
import { registerRepositoryCommands } from "./repository-commands.js";
import { registerWorkspaceCommands } from "./workspace-commands.js";
import { registerWorkspaceExecutionCommands } from "./workspace-execution-commands.js";
import { registerWorkspaceLifecycleCommands } from "./workspace-lifecycle-commands.js";

const program = new Command();

program
  .name("dim")
  .description("Isolated, persistent development workspaces")
  .version(packageVersion)
  .showSuggestionAfterError()
  .configureHelp({ sortSubcommands: true, sortOptions: true })
  .addHelpText("afterAll", installerFacadeHelpText(program));

registerProjectCommands(program);
registerRepositoryCommands(program);
registerCiCommands(program);
const workspace = registerWorkspaceCommands(program);
registerWorkspaceExecutionCommands(program, workspace);
registerWorkspaceLifecycleCommands(workspace);
registerDoctorAndPluginCommands(program);
registerExternalUrlCommands(program);
registerControllerCommands(program);
registerControlPlaneInstallCommand(program);
registerHostIntegrationCommands(program);

program.exitOverride();

main();

async function main(): Promise<void> {
  try {
    if (process.platform !== "linux") {
      throw new UserError(`DIM requires a Linux host; unsupported platform '${process.platform}'`);
    }
    const argv = process.argv[2] === "--"
      ? [process.argv[0] ?? "node", process.argv[1] ?? "dim", ...process.argv.slice(3)]
      : process.argv;
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return;
      process.exitCode = error.exitCode || 2;
      return;
    }
    if (error instanceof UserError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  }
}
