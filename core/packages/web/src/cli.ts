#!/usr/bin/env node
import { initializeOperationsWeb, initializeReviewerWeb } from "./initialize.js";
import { parseArgs } from "node:util";
import { createReviewerWebServerFromConfigFile } from "./index.js";

async function main(): Promise<void> {
  const [operation, configPath, ...flags] = process.argv.slice(2);
  if (operation === "init" && configPath !== undefined) {
    const { values } = parseArgs({ args: flags, options: { project: { type: "string" }, output: { type: "string" }, port: { type: "string" }, operations: { type: "string" }, promoter: { type: "string" } } });
    if (!values.project || !values.output) throw new Error("init requires --project PROJECT --output CONFIG");
    const result = await initializeReviewerWeb({ connection: configPath, project: values.project, output: values.output,
      ...(values.operations === undefined ? {} : { operations: values.operations }),
      ...(values.promoter === undefined ? {} : { promoter: values.promoter }),
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
    process.stderr.write("usage: dim-reviewer-web init CONNECTION --project PROJECT --output CONFIG [--port PORT] [--operations FILE] [--promoter CONNECTION]\n       dim-reviewer-web init-operations OPERATIONS --output CONFIG [--port PORT]\n       dim-reviewer-web serve /absolute/path/to/config.json\n");
    process.exitCode = 2;
    return;
  }
  const service = await createReviewerWebServerFromConfigFile(configPath);
  process.stdout.write(`${await service.listen()}\n`);
  const close = async (): Promise<void> => service.close();
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "reviewer web startup failed"}\n`);
  process.exitCode = 1;
});
