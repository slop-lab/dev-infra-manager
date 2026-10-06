import { readFile } from "node:fs/promises";
import { configuredNativeOrdinaryIdleServer } from "../../../../../core/packages/core/dist/nativeOrdinaryIdleService.js";
import { parseNativeOrdinaryBundleConfig } from "../../../../../core/packages/core/dist/nativeOrdinaryBundleConfig.js";

process.umask(0o022);

const [configPath, stateDirectory, readinessTokenPath, activationTokenPath, expectedGenerationId] = process.argv.slice(2);
if (configPath === undefined || stateDirectory === undefined || readinessTokenPath === undefined
  || activationTokenPath === undefined || expectedGenerationId === undefined) {
  throw new TypeError("idle process fixture requires config, state, readiness, activation, and generation arguments");
}

const config = parseNativeOrdinaryBundleConfig(JSON.parse(await readFile(configPath, "utf8")));
const server = await configuredNativeOrdinaryIdleServer({
  config,
  stateDirectory,
  readinessToken: (await readFile(readinessTokenPath, "utf8")).trimEnd(),
  activationToken: (await readFile(activationTokenPath, "utf8")).trimEnd(),
  expectedGenerationId
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("idle process fixture has no TCP address");
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});

process.once("SIGTERM", () => {
  server.close((error) => {
    if (error !== undefined) throw error;
    process.exitCode = 0;
  });
  server.closeAllConnections();
});
