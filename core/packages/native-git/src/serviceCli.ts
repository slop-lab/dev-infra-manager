#!/usr/bin/env node
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request } from "node:http";
import { pathToFileURL } from "node:url";
import { parseNativeGitBundle, parseNativeGitBundleConfig } from "./bundle-config.js";
import { inspectNativeGitBundleState } from "./native-bundle-state.js";
import { configuredNativeGitIdleServer } from "./native-idle-service.js";
import { checkNativeGitServiceReadiness } from "./serviceReadiness.js";

const configPath = "/run/secrets/service.json";
const stateDirectory = "/var/lib/dim-native-git";
const readinessTokenPath = "/run/secrets/readiness.token";
const activationTokenPath = "/run/secrets/activation.token";
const activationResponseLimit = 4 * 1024;
const activationTimeoutMilliseconds = 2_000;

const USAGE = [
  "usage: dim-service check-config /run/secrets/service.json",
  "       dim-service check-bundle-config /run/native.json /run/ordinary.json",
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
    parseNativeGitBundleConfig(await readJson(arguments_[1]));
    return;
  }
  if (command === "check-bundle-config" && arguments_.length === 3) {
    const [native, ordinary] = await Promise.all([readJson(arguments_[1]), readJson(arguments_[2])]);
    parseNativeGitBundle(native, ordinary);
    return;
  }
  if (command === "compatibility" && arguments_.length === 2 && arguments_[1] === "--json") {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, writeFormat: 3, readableFormats: [3] })}\n`);
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
    const config = parseNativeGitBundleConfig(await readJson(configPath, 0o444));
    const server = await configuredNativeGitIdleServer({
      config,
      stateDirectory,
      readinessToken: await readToken(readinessTokenPath, "readiness"),
      activationToken: await readToken(activationTokenPath, "activation"),
      expectedGenerationId
    });
    await listenUntilTermination(server);
    return;
  }
  if (command === "activate" && arguments_.length === 2) {
    const generationId = parseGenerationId(arguments_[1]);
    await activate(generationId, await readToken(activationTokenPath, "activation"));
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

async function activate(generationId: string, token: string): Promise<void> {
  const body = JSON.stringify({ schemaVersion: 1, generationId });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(new NativeGitServiceCliError("native Git activation failed"));
    };
    const outgoing = request("http://127.0.0.1:8080/v1/activation", {
      method: "POST",
      agent: false,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      }
    }, (incoming) => {
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > activationResponseLimit) {
          incoming.destroy();
          fail();
        }
        else chunks.push(chunk);
      });
      incoming.once("error", fail);
      incoming.once("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        const response = exactActivationResponse(Buffer.concat(chunks).toString("utf8"), generationId);
        if (incoming.statusCode === 200 && incoming.headers["content-type"] === "application/json"
          && incoming.headers["cache-control"] === "no-store" && response) resolve();
        else reject(new NativeGitServiceCliError("native Git activation failed"));
      });
    });
    const deadline = setTimeout(() => {
      outgoing.destroy();
      fail();
    }, activationTimeoutMilliseconds);
    outgoing.once("error", fail);
    outgoing.end(body);
  });
}

function exactActivationResponse(body: string, generationId: string): boolean {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && Object.keys(value).length === 3 && Reflect.get(value, "schemaVersion") === 1
      && Reflect.get(value, "generationId") === generationId && Reflect.get(value, "activated") === true;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
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

async function listenUntilTermination(server: import("node:http").Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(8080, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    const close = () => {
      process.off("SIGTERM", close);
      process.off("SIGINT", close);
      server.close((error) => error === undefined ? resolve() : reject(error));
      server.closeAllConnections();
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
    server.once("error", reject);
  });
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  runNativeGitServiceCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "native Git service preflight failed"}\n`);
    process.exitCode = 1;
  });
}
