#!/usr/bin/env node
import { createReviewerWebServerFromConfigFile } from "./index.js";

async function main(): Promise<void> {
  const [operation, configPath] = process.argv.slice(2);
  if (operation !== "serve" || configPath === undefined || process.argv.length !== 4) {
    process.stderr.write("usage: dim-reviewer-web serve /absolute/path/to/config.json\n");
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
