#!/usr/bin/env node
import { parseControlPlaneServicePair, parseManagedGitServiceConfig } from "@slop-lab/dim-control-plane-admin/service-pair";
import { managedGitPluginEntries } from "./composition.js";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { activateNativeGitGeneration } from "./native-git-activation.js";
import { pathToFileURL } from "node:url";
import { startControlPlanePlugins } from "@slop-lab/dim-control-plane-core";
import { inspectNativeGitBundleState } from "@slop-lab/dim-control-plane-plugin-git-repositories/service";
import { assertGitVersion } from "@slop-lab/dim-control-plane-plugin-git-repositories/service";
import { checkNativeGitServiceReadiness } from "@slop-lab/dim-control-plane-plugin-git-repositories/service";

const configPath = "/run/secrets/service.json";
const stateDirectory = "/var/lib/dim-native-git";
const readinessTokenPath = "/run/secrets/readiness.token";
const activationTokenPath = "/run/secrets/activation.token";
const activationTimeoutMilliseconds = 120_000;

const USAGE = [
  "usage: dim-service check-config /run/secrets/service.json",
  "       dim-service check-bundle-config /run/native.json /run/execution.json",
  "       dim-service compatibility --json",
  "       dim-service check-state --read-only /var/lib/dim-native-git --json",
  "       dim-service serve /run/secrets/service.json GENERATION_ID",
  "       dim-service ready",
  "       dim-service activate GENERATION_ID"
].join("\n");

export type NativeGitServiceCliDependencies = { readonly stateDirectory?: string };

export async function runNativeGitServiceCli(
  arguments_: readonly string[],
  dependencies: NativeGitServiceCliDependencies = {}
): Promise<void> {
  const command = arguments_[0];
  if (command === "check-config" && arguments_.length === 2) {
    const config = parseManagedGitServiceConfig(await readJson(arguments_[1]));
    await assertGitVersion(config);
    return;
  }
  if (command === "check-bundle-config" && arguments_.length === 3) {
    const [native, execution] = await Promise.all([readJson(arguments_[1]), readJson(arguments_[2])]);
    parseControlPlaneServicePair(native, execution);
    return;
  }
  if (command === "compatibility" && arguments_.length === 2 && arguments_[1] === "--json") {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, writeFormat: 12, readableFormats: [10, 11, 12] })}\n`);
    return;
  }
  if (command === "check-state" && arguments_.length === 4 && arguments_[1] === "--read-only"
    && arguments_[2] === stateDirectory && arguments_[3] === "--json") {
    const state = await inspectNativeGitBundleState(dependencies.stateDirectory ?? stateDirectory);
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, stateFormat: state.stateFormat })}\n`);
    return;
  }
  if (command === "serve" && arguments_.length === 3 && arguments_[1] === configPath) {
    const expectedGenerationId = parseGenerationId(arguments_[2]);
    const config = parseManagedGitServiceConfig(await readJson(configPath, 0o444));
    const shutdown = new AbortController();
    const stop = () => shutdown.abort();
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    let service: Awaited<ReturnType<typeof startControlPlanePlugins>> | undefined;
    try {
      service = await startControlPlanePlugins(managedGitPluginEntries({ config, stateDirectory,
        readinessToken: await readToken(readinessTokenPath, "readiness"),
        activationToken: await readToken(activationTokenPath, "activation"), expectedGenerationId
      }), shutdown.signal);
      if (!shutdown.signal.aborted) await new Promise<void>((resolve) => shutdown.signal.addEventListener("abort", () => resolve(), { once: true }));
    } finally {
      process.off("SIGTERM", stop); process.off("SIGINT", stop);
      await service?.close();
    }
    return;
  }
  if (command === "activate" && arguments_.length === 2) {
    const generationId = parseGenerationId(arguments_[1]);
    await activateNativeGitGeneration({ origin: "http://127.0.0.1:8080", generationId, token: await readToken(activationTokenPath, "activation"), timeoutMilliseconds: activationTimeoutMilliseconds });
    return;
  }
  if (command === "ready" && arguments_.length === 1) {
    await checkNativeGitServiceReadiness({ tokenPath: readinessTokenPath, origin: "http://127.0.0.1:8080" });
    return;
  }
  throw new NativeGitServiceCliError(USAGE);
}

async function readJson(path: string | undefined, requiredMode?: number): Promise<unknown> {
  if (path === undefined) throw new NativeGitServiceCliError(USAGE);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new NativeGitServiceCliError("configuration path must be a regular file");
    if (requiredMode !== undefined && (metadata.mode & 0o777) !== requiredMode) {
      throw new NativeGitServiceCliError("configuration path must be a mode-0444 regular file");
    }
    try {
      return JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new NativeGitServiceCliError("configuration file must contain valid JSON");
      throw error;
    }
  } finally {
    await handle.close();
  }
}

export class NativeGitServiceCliError extends Error {
  readonly name = "NativeGitServiceCliError";
}

function parseGenerationId(value: string | undefined): string {
  if (value === undefined || !/^[0-9a-f]{64}$/.test(value)) throw new NativeGitServiceCliError(USAGE);
  return value;
}

async function readToken(path: string, label: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o444) {
      throw new NativeGitServiceCliError(`${label} token path must be a mode-0444 regular file`);
    }
    const value = await handle.readFile("utf8");
    if (!/^[A-Za-z0-9_-]+\n$/.test(value)) throw new NativeGitServiceCliError(`${label} token file is invalid`);
    return value.slice(0, -1);
  } finally {
    await handle.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  runNativeGitServiceCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "native Git service preflight failed"}\n`);
    process.exitCode = 1;
  });
}
