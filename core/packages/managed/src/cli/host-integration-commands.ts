import { type Command } from "commander";
import { UserError } from "@slop-lab/dim-managed";
import {
  controllerRequest
} from "./cli-support.js";

export function registerHostIntegrationCommands(program: Command): void {
const hostInput = program.command("host-input").description("Read an allowed host setting from a workspace");
hostInput.command("get")
  .argument("<provider>")
  .argument("<key>")
  .option("--parameters <parameters>")
  .action(async (provider: string, key: string, flags: { parameters?: string }) => {
    const result = await controllerRequest(
      `/api/host-inputs/${encodeURIComponent(provider)}`,
      {
        method: "POST",
        body: JSON.stringify({ key, ...(flags.parameters === undefined ? {} : { parameters: flags.parameters }) })
      }
    ) as { value?: unknown };
    if (typeof result.value !== "string") throw new UserError("host input provider returned an invalid value");
    process.stdout.write(`${result.value}\n`);
  });

program.command("help")
  .description("Show help")
  .action(() => {
    program.outputHelp();
  });
}
