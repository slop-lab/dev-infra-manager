#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { UserError } from "@slop-lab/dim-managed";
import { installerFacadeHelpText } from "./cli-runtime.js";
import { registerControlPlaneCommands } from "./control-plane-commands.js";
import { registerCiCommands } from "./ci-commands.js";
import { registerControllerCommands } from "./controller-commands.js";
import { registerDoctorAndPluginCommands } from "./doctor-plugin-commands.js";
import { registerExternalUrlCommands } from "./external-url-commands.js";
import { registerHostIntegrationCommands } from "./host-integration-commands.js";
import { packageVersion } from "./package-version.js";
import { registerProjectCommands } from "./project-commands.js";

const program = new Command();

program
  .name("dim managed")
  .description("Optional managed Git, review, CI and workspace administration")
  .version(packageVersion)
  .showSuggestionAfterError()
  .configureHelp({ sortSubcommands: true, sortOptions: true })
  .addHelpText("afterAll", installerFacadeHelpText(program));

registerControlPlaneCommands(program);
registerProjectCommands(program);
registerCiCommands(program);
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
