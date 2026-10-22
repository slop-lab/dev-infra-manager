#!/usr/bin/env node
import { initializeOperationsWeb, initializeFeaturesWeb } from "./initialize.js";
import { parseArgs } from "node:util";
import { createWebServerFromConfigFile } from "./index.js";
import { runAccountCli, accountUsage } from "./account-cli.js";

async function main(): Promise<void> {
  if (process.argv[2] === "account") return runAccountCli(process.argv.slice(3));
  if (process.argv[2] === "--help" || process.argv[2] === "help") {
    process.stdout.write(`dim-web serve CONFIG\ndim-web init-operations OPERATIONS --output CONFIG [--port PORT]\ndim-web init-features SPEC --output CONFIG --roles read,operator,reviewer,account-admin [--port PORT]\n${accountUsage}`); return;
  }
  const [operation, configPath, ...flags] = process.argv.slice(2);
  if (operation === "init-features" && configPath !== undefined) {
    const { values } = parseArgs({ args: flags, options: { output: { type: "string" }, port: { type: "string" }, roles: { type: "string" } } });
    if (!values.output || !values.roles) throw new Error("init-features requires --output CONFIG --roles read,operator,reviewer,account-admin (choose explicit roles)");
    const result = await initializeFeaturesWeb({ specification: configPath, roles: values.roles.split(","), output: values.output,
      ...(values.port === undefined ? {} : { port: /^\d+$/.test(values.port) ? Number(values.port) : NaN }) });
    process.stdout.write(`Configuration: ${result.configPath}\nBrowser username: ${result.username}\nBrowser password: ${result.password}\n`);
    return;
  }
  if (operation === "init-operations" && configPath !== undefined) {
    const { values } = parseArgs({ args: flags, options: { output: { type: "string" }, port: { type: "string" } } });
    if (!values.output) throw new Error("init-operations requires --output CONFIG");
    const result = await initializeOperationsWeb({ operations: configPath, output: values.output,
      ...(values.port === undefined ? {} : { port: /^\d+$/.test(values.port) ? Number(values.port) : NaN }) });
    process.stdout.write(`Configuration: ${result.configPath}\nBrowser username: ${result.username}\nBrowser password: ${result.password}\n`);
    return;
  }
  if (operation !== "serve" || configPath === undefined || process.argv.length !== 4) {
    process.stderr.write("usage: dim-web init-features SPEC --output CONFIG --roles read,operator,reviewer,account-admin [--port PORT]\n       dim-web init-operations OPERATIONS --output CONFIG [--port PORT]\n       dim-web serve /absolute/path/to/config.json\n");
    process.exitCode = 2;
    return;
  }
  const service = await createWebServerFromConfigFile(configPath);
  process.stdout.write(`${await service.listen()}\n`);
  const close = async (): Promise<void> => service.close();
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "web startup failed"}\n`);
  process.exitCode = 1;
});
