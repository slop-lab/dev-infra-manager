#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { UserError } from "@slop-lab/dim-core";
import { installerFacadeHelpText } from "./cli-runtime.js";
import { registerCiCommands } from "./ci-commands.js";
import { registerControllerCommands } from "./controller-commands.js";
import { registerDoctorAndPluginCommands } from "./doctor-plugin-commands.js";
import { registerExternalUrlCommands } from "./external-url-commands.js";
import { registerHostIntegrationCommands } from "./host-integration-commands.js";
import { packageVersion } from "./package-version.js";
import { registerProjectCommands } from "./project-commands.js";
import { registerWorkspaceCommands } from "./workspace-commands.js";
import { registerWorkspaceExecutionCommands } from "./workspace-execution-commands.js";
import { registerWorkspaceImageCommands } from "./workspace-image-commands.js";
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
registerCiCommands(program);
const workspace = program.command("workspace").description("Manage persistent development workspaces");
for (const parent of [program, workspace]) {
  registerWorkspaceCommands(parent);
  registerWorkspaceExecutionCommands(parent);
  registerWorkspaceLifecycleCommands(parent);
}
registerWorkspaceImageCommands(workspace);
registerDoctorAndPluginCommands(program);
registerExternalUrlCommands(program);
registerControllerCommands(program);
registerHostIntegrationCommands(program);

program.exitOverride();



export async function runManagedCli(args: string[]): Promise<void> {
  try {
    if (process.platform !== "linux") {
      throw new UserError(`DIM requires a Linux host; unsupported platform '${process.platform}'`);
    }
    await program.parseAsync(args, { from: "user" });
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
