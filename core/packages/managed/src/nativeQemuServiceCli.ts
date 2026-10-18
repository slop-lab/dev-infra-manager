#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { configuredNativeQemuSchedulerServer } from "./nativeQemuSchedulerService.js";
import { loadNativeQemuSchedulerConfig } from "./nativeQemuSchedulerConfig.js";

const usage = "usage: dim-native-qemu-service check-config CONFIG | compatibility --json | serve CONFIG";

export async function runNativeQemuServiceCli(arguments_: readonly string[]): Promise<void> {
  if (arguments_.length === 2 && arguments_[0] === "check-config") {
    await loadNativeQemuSchedulerConfig(required(arguments_[1])); return;
  }
  if (arguments_.length === 2 && arguments_[0] === "compatibility" && arguments_[1] === "--json") {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, writeFormat: 1, readableFormats: [1] })}\n`); return;
  }
  if (arguments_.length === 2 && arguments_[0] === "serve") {
    const config = await loadNativeQemuSchedulerConfig(required(arguments_[1]));
    const server = configuredNativeQemuSchedulerServer(config);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject); server.listen(config.port, config.host, () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      const close = () => server.close((error) => error === undefined ? resolve() : reject(error));
      process.once("SIGINT", close); process.once("SIGTERM", close); server.once("error", reject);
    });
    return;
  }
  throw new NativeQemuServiceCliError(usage);
}
function required(value: string | undefined): string { if (value === undefined) throw new NativeQemuServiceCliError(usage); return value; }
export class NativeQemuServiceCliError extends Error { readonly name = "NativeQemuServiceCliError"; }
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.umask(0o077);
  runNativeQemuServiceCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "native QEMU service failed"}\n`); process.exitCode = 1;
  });
}
