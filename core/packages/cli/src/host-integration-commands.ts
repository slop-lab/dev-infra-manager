import { type Command } from "commander";
import { UserError } from "@slop-lab/dim-core";
import {
  adminCall, adminStreamCall, controllerRequest, print, type JsonFlags
} from "./cli-support.js";

export function registerHostIntegrationCommands(program: Command): void {
  const host = program.command("host").description("Manage DIM host runtime lifecycle");
host.command("status")
  .description("Show DIM host runtime readiness and pending restore targets")
  .option("--json", "print machine-readable JSON")
  .action(async (flags: JsonFlags) => print(await adminCall("host.status"), flags));
host.command("shutdown")
  .description("Gracefully stop DIM runtimes while preserving all managed volumes")
  .action(async () => {
    await adminStreamCall("host.shutdown");
    console.log("DIM host runtimes are stopped; the controller remains available");
  });
host.command("start")
  .description("Restore the DIM runtimes that were active before host shutdown")
  .action(async () => {
    await adminStreamCall("host.start");
    console.log("DIM host runtimes are ready");
  });

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
