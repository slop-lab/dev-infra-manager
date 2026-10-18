import { constants, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { UserError } from "@slop-lab/dim-core";

const maximumConfigBytes = 64 * 1024;
const hostFields = ["schemaVersion", "hostId", "generationId", "stateDirectory", "gitExecutable",
  "ordinaryCi", "nativeGit", "capacities"] as const;
const ordinaryFields = ["transport", "endpoint", "serviceId", "credential"] as const;
const nativeGitFields = ["transport", "endpoint", "serviceId"] as const;
const credentialFields = ["username", "password"] as const;

type Transport = "https" | "loopback-http";
type Credential = { readonly username: string; readonly password: string };

export type NativeRootCiHostConfig = {
  readonly schemaVersion: 1;
  readonly hostId: string;
  readonly generationId: string;
  readonly stateDirectory: string;
  readonly gitExecutable: string;
  readonly ordinaryCi: {
    readonly transport: Transport;
    readonly endpoint: string;
    readonly serviceId: "ordinary-main";
    readonly credential: Credential;
  };
  readonly nativeGit: {
    readonly transport: Transport;
    readonly endpoint: string;
    readonly serviceId: "native-main";
  };
  readonly capacities: readonly string[];
};

export class NativeRootCiHostConfigError extends UserError {
  readonly name = "NativeRootCiHostConfigError";
}

export function parseNativeRootCiHostConfig(value: unknown): NativeRootCiHostConfig {
  const input = exactRecord(value, hostFields);
  const ordinary = exactRecord(input.ordinaryCi, ordinaryFields);
  const nativeGit = exactRecord(input.nativeGit, nativeGitFields);
  if (input.schemaVersion !== 1 || ordinary.serviceId !== "ordinary-main"
    || nativeGit.serviceId !== "native-main" || !Array.isArray(input.capacities)
    || input.capacities.length === 0) invalid();
  const hostId = identifier(input.hostId);
  const ordinaryCredential = credential(ordinary.credential);
  const capacities = input.capacities.map(identifier);
  if (ordinaryCredential.username !== hostId || new Set(capacities).size !== capacities.length) invalid();
  return {
    schemaVersion: 1,
    hostId,
    generationId: generation(input.generationId),
    stateDirectory: absolutePath(input.stateDirectory),
    gitExecutable: absolutePath(input.gitExecutable),
    ordinaryCi: {
      transport: transport(ordinary.transport),
      endpoint: origin(ordinary.endpoint, transport(ordinary.transport)),
      serviceId: "ordinary-main",
      credential: ordinaryCredential
    },
    nativeGit: {
      transport: transport(nativeGit.transport),
      endpoint: origin(nativeGit.endpoint, transport(nativeGit.transport)),
      serviceId: "native-main"
    },
    capacities
  };
}

export function loadNativeRootCiHostConfig(path: string): Promise<NativeRootCiHostConfig> {
  return loadConfig(path, parseNativeRootCiHostConfig);
}

async function loadConfig<T>(path: string, parser: (value: unknown) => T): Promise<T> {
  if (!isAbsolute(path)) {
    throw new NativeRootCiHostConfigError("native root CI config path must be absolute");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new NativeRootCiHostConfigError("native root CI config cannot be opened safely", { cause: error });
  }
  try {
    const before = await handle.stat({ bigint: true });
    assertFileMetadata(before);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (metadataChanged(before, after) || bytes.length !== Number(before.size)) invalid();
    try {
      return parser(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if (error instanceof SyntaxError) invalid();
      throw error;
    }
  } finally {
    await handle.close();
  }
}

function assertFileMetadata(metadata: BigIntStats): void {
  const owner = process.geteuid?.();
  if (!metadata.isFile() || metadata.isSymbolicLink() || owner === undefined
    || metadata.uid !== BigInt(owner) || metadata.nlink !== 1n
    || (metadata.mode & 0o777n) !== 0o600n || metadata.size < 1n
    || metadata.size > BigInt(maximumConfigBytes)) {
    throw new NativeRootCiHostConfigError("native root CI config requires an owner-only regular file");
  }
}

function metadataChanged(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    || before.mode !== after.mode || before.uid !== after.uid || before.nlink !== after.nlink;
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || Object.keys(value).length !== fields.length
    || fields.some((field) => !Object.hasOwn(value, field))) invalid();
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credential(value: unknown): Credential {
  const input = exactRecord(value, credentialFields);
  return { username: username(input.username), password: secret(input.password) };
}

function transport(value: unknown): Transport {
  if (value !== "https" && value !== "loopback-http") invalid();
  return value;
}

function origin(value: unknown, selectedTransport: Transport): string {
  if (typeof value !== "string") invalid();
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { return invalid(); }
  if (value !== parsed.origin || parsed.username !== "" || parsed.password !== ""
    || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== ""
    || (selectedTransport === "https" && parsed.protocol !== "https:")
    || (selectedTransport === "loopback-http" && (parsed.protocol !== "http:"
      || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]")))) invalid();
  return value;
}

function absolutePath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || value === "/") invalid();
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) invalid();
  return value;
}

function username(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/.test(value)) invalid();
  return value;
}

function generation(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid();
  return value;
}

function secret(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) invalid();
  return value;
}

function invalid(): never {
  throw new NativeRootCiHostConfigError("native root CI host config is invalid");
}
