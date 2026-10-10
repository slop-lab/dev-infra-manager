import { constants, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import { UserError } from "./errors.js";
import { hasDuplicateJsonKeys } from "./nativeControlPlaneJson.js";

const maximumBytes = 64 * 1024;
const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const imagePattern = /^(?:(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;

type ServiceConnection = {
  readonly transport: "https" | "loopback-http";
  readonly endpoint: string;
};
type Capacity = {
  readonly runnerBaseImage: string;
  readonly jobBaseImage: string;
  readonly cpus: number;
  readonly memoryBytes: number;
  readonly pids: number;
  readonly timeoutSeconds: number;
  readonly outputBytes: number;
};

export type NativeControlPlaneConnection = {
  readonly schemaVersion: 1;
  readonly hostId: string;
  readonly nativeGit: ServiceConnection & {
    readonly serviceId: "native-main";
    readonly username: string;
    readonly password: string;
  };
  readonly ordinaryCi: ServiceConnection & {
    readonly serviceId: "ordinary-main";
    readonly hostToken: string;
  };
  readonly capacities: Readonly<Record<string, Capacity>>;
};

export class NativeControlPlaneConnectionError extends UserError {
  readonly name = "NativeControlPlaneConnectionError";
}

export function parseNativeControlPlaneConnection(value: unknown): NativeControlPlaneConnection {
  const input = exactRecord(value, ["schemaVersion", "hostId", "nativeGit", "ordinaryCi", "capacities"]);
  if (input.schemaVersion !== 1) return invalid();
  const hostId = identifier(input.hostId);
  const git = exactRecord(input.nativeGit, ["transport", "endpoint", "serviceId", "username", "password"]);
  const ordinary = exactRecord(input.ordinaryCi, ["transport", "endpoint", "serviceId", "hostToken"]);
  if (git.serviceId !== "native-main" || ordinary.serviceId !== "ordinary-main"
    || git.username !== hostId) return invalid();
  const nativeTransport = transport(git.transport);
  const ordinaryTransport = transport(ordinary.transport);
  const password = token(git.password);
  const hostToken = token(ordinary.hostToken);
  if (password === hostToken) return invalid();
  const configured = record(input.capacities);
  const entries = Object.entries(configured);
  if (entries.length === 0) return invalid();
  const capacities: Record<string, Capacity> = {};
  for (const [name, value] of entries) {
    identifier(name);
    const policy = exactRecord(value, ["runnerBaseImage", "jobBaseImage", "cpus",
      "memoryBytes", "pids", "timeoutSeconds", "outputBytes"]);
    capacities[name] = {
      runnerBaseImage: pinnedImage(policy.runnerBaseImage),
      jobBaseImage: pinnedImage(policy.jobBaseImage),
      cpus: positiveInteger(policy.cpus),
      memoryBytes: positiveInteger(policy.memoryBytes),
      pids: positiveInteger(policy.pids),
      timeoutSeconds: positiveInteger(policy.timeoutSeconds),
      outputBytes: positiveInteger(policy.outputBytes)
    };
  }
  return {
    schemaVersion: 1,
    hostId,
    nativeGit: { transport: nativeTransport, endpoint: origin(git.endpoint, nativeTransport),
      serviceId: "native-main", username: hostId, password },
    ordinaryCi: { transport: ordinaryTransport, endpoint: origin(ordinary.endpoint, ordinaryTransport),
      serviceId: "ordinary-main", hostToken },
    capacities
  };
}

export async function loadNativeControlPlaneConnection(path: string): Promise<NativeControlPlaneConnection> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new NativeControlPlaneConnectionError("native control-plane connection cannot be opened safely", { cause: error });
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || process.geteuid?.() === undefined
      || before.uid !== BigInt(process.geteuid()) || before.nlink !== 1n
      || (before.mode & 0o777n) !== 0o600n || before.size < 1n || before.size > BigInt(maximumBytes)) return invalid();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) return invalid();
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (changed(before, after)) return invalid();
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) return invalid();
      throw error;
    }
    if (hasDuplicateJsonKeys(bytes.toString("utf8"))) return invalid();
    return parseNativeControlPlaneConnection(value);
  } finally {
    await handle.close();
  }
}

function changed(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.mode !== after.mode
    || before.uid !== after.uid || before.nlink !== after.nlink;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return invalid();
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  const input = record(value);
  if (Object.keys(input).length !== fields.length || fields.some((field) => !Object.hasOwn(input, field))) return invalid();
  return input;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) return invalid();
  return value;
}

function token(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) return invalid();
  return value;
}

function transport(value: unknown): ServiceConnection["transport"] {
  if (value !== "https" && value !== "loopback-http") return invalid();
  return value;
}

function origin(value: unknown, selected: ServiceConnection["transport"]): string {
  if (typeof value !== "string") return invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (error instanceof TypeError) return invalid();
    throw error;
  }
  if (value !== url.origin || url.username !== "" || url.password !== ""
    || url.pathname !== "/" || url.search !== "" || url.hash !== ""
    || (selected === "https" && url.protocol !== "https:")
    || (selected === "loopback-http" && (url.protocol !== "http:"
      || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]")))) return invalid();
  return value;
}

function pinnedImage(value: unknown): string {
  if (typeof value !== "string" || !imagePattern.test(value)) return invalid();
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return invalid();
  return value;
}

function invalid(): never {
  throw new NativeControlPlaneConnectionError("native control-plane host connection is invalid");
}
