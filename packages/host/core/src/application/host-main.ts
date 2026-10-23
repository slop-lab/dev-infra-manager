#!/usr/bin/env node
import { CliHostProtocolError } from "@slop-lab/dim-contracts-cli-host";
import { CommanderError } from "commander";
import { UserError } from "../errors.js";
import { packageVersion } from "../package-version.js";

try {
  const args = process.argv.slice(2);
  if (args[0] === "__host") {
    if (args.length !== 2) throw new CliHostProtocolError("Host mode requires exactly one protocol envelope");
    const { runCliHostRequest } = await import("./cli-host.js");
    await runCliHostRequest(args[1]!);
  } else if (args.length === 1 && args[0] === "--host-protocol") {
    const { hostProtocolCapabilities } = await import("./cli-host.js");
    console.log(JSON.stringify(hostProtocolCapabilities()));
  } else if (args.length === 1 && ["--version", "-V"].includes(args[0]!)) {
    console.log(packageVersion);
  } else {
    const { runHostCommand } = await import("./commands/index.js");
    await runHostCommand(args);
  }
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = ["commander.helpDisplayed", "commander.help", "commander.version"].includes(error.code) ? 0 : error.exitCode || 2;
  } else {
    console.error(`dim-host: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof CliHostProtocolError || error instanceof UserError ? 2 : 1;
  }
}
