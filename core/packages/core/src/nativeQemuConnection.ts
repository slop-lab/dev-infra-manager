import { constants, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import { UserError } from "./errors.js";

const maximumConnectionBytes = 64 * 1024;
const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const imagePattern = /^(?:(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;

export type NativeQemuConnection = {
  readonly schemaVersion: 1;
  readonly hostId: string;
  readonly scheduler: {
    readonly transport: "https" | "loopback-http";
    readonly endpoint: string;
    readonly serviceId: "qemu-main";
    readonly hostToken: string;
  };
  readonly capacities: readonly {
    readonly capacity: string;
    readonly runnerBaseImage: string;
    readonly jobBaseImage: string;
    readonly cpus: number;
    readonly memoryBytes: number;
    readonly pids: number;
    readonly timeoutSeconds: number;
    readonly outputBytes: number;
  }[];
};

export class NativeQemuConnectionError extends UserError {
  readonly name = "NativeQemuConnectionError";
}

export function parseNativeQemuConnection(value: unknown, expectedHostId: string): NativeQemuConnection {
  const expected = identifier(expectedHostId);
  const input = exactRecord(value, ["schemaVersion", "hostId", "scheduler", "capacities"]);
  if (input.schemaVersion !== 1 || identifier(input.hostId) !== expected) invalid();
  const scheduler = exactRecord(input.scheduler, ["transport", "endpoint", "serviceId", "hostToken"]);
  if (scheduler.serviceId !== "qemu-main") invalid();
  const transport = parseTransport(scheduler.transport);
  if (!Array.isArray(input.capacities) || input.capacities.length === 0) invalid();
  const capacities = input.capacities.map((value: unknown): NativeQemuConnection["capacities"][number] => {
    const capacity = exactRecord(value, ["capacity", "runnerBaseImage", "jobBaseImage", "cpus",
      "memoryBytes", "pids", "timeoutSeconds", "outputBytes"]);
    return {
      capacity: identifier(capacity.capacity),
      runnerBaseImage: pinnedImage(capacity.runnerBaseImage),
      jobBaseImage: pinnedImage(capacity.jobBaseImage),
      cpus: positiveInteger(capacity.cpus),
      memoryBytes: positiveInteger(capacity.memoryBytes),
      pids: positiveInteger(capacity.pids),
      timeoutSeconds: positiveInteger(capacity.timeoutSeconds),
      outputBytes: positiveInteger(capacity.outputBytes)
    };
  });
  if (new Set(capacities.map(({ capacity }) => capacity)).size !== capacities.length) invalid();
  return {
    schemaVersion: 1,
    hostId: expected,
    scheduler: { transport, endpoint: origin(scheduler.endpoint, transport),
      serviceId: "qemu-main", hostToken: token(scheduler.hostToken) },
    capacities
  };
}

export async function loadNativeQemuConnection(path: string, expectedHostId: string): Promise<NativeQemuConnection> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new NativeQemuConnectionError("native QEMU connection cannot be opened safely", { cause: error });
  }
  try {
    const before = await handle.stat({ bigint: true });
    assertFileMetadata(before);
    const bytes = Buffer.alloc(Number(before.size));
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
      if (bytesRead === 0) invalid();
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (metadataChanged(before, after)) invalid();
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) invalid();
      throw error;
    }
    return parseNativeQemuConnection(value, expectedHostId);
  } finally {
    await handle.close();
  }
}

function assertFileMetadata(metadata: BigIntStats): void {
  const owner = process.geteuid?.();
  if (!metadata.isFile() || metadata.isSymbolicLink() || owner === undefined
    || metadata.uid !== BigInt(owner) || metadata.nlink !== 1n
    || (metadata.mode & 0o777n) !== 0o600n
    || metadata.size < 1n || metadata.size > BigInt(maximumConnectionBytes)) invalid();
}

function metadataChanged(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.mode !== after.mode
    || before.uid !== after.uid || before.nlink !== after.nlink;
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || Object.keys(value).length !== fields.length
    || fields.some((field) => !Object.hasOwn(value, field))) invalid();
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) invalid();
  return value;
}

function parseTransport(value: unknown): NativeQemuConnection["scheduler"]["transport"] {
  if (value !== "https" && value !== "loopback-http") invalid();
  return value;
}

function origin(value: unknown, transport: NativeQemuConnection["scheduler"]["transport"]): string {
  if (typeof value !== "string") invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (value !== url.origin || url.username !== "" || url.password !== ""
    || url.pathname !== "/" || url.search !== "" || url.hash !== ""
    || (transport === "https" && url.protocol !== "https:")
    || (transport === "loopback-http" && (url.protocol !== "http:"
      || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]")))) invalid();
  return value;
}

function token(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) invalid();
  return value;
}

function pinnedImage(value: unknown): string {
  if (typeof value !== "string" || !imagePattern.test(value)) invalid();
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) invalid();
  return value;
}

function invalid(): never {
  throw new NativeQemuConnectionError("native QEMU host connection is invalid");
}
