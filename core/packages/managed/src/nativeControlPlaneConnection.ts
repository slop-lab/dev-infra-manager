import { constants, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import { UserError } from "@slop-lab/dim-core";
import { hasDuplicateJsonKeys } from "./nativeControlPlaneJson.js";

const maximumBytes = 64 * 1024;
const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;

type ServiceConnection = {
  readonly transport: "https" | "loopback-http";
  readonly endpoint: string;
};
type Credential = {
  readonly username: string;
  readonly password: string;
};

export type NativeControlPlaneConnection = {
  readonly schemaVersion: 1;
  readonly hostId: string;
  readonly nativeGit: ServiceConnection & {
    readonly serviceId: "native-main";
    readonly generationId: string;
    readonly workspaceWriteIssuer: Credential;
    readonly rootReadIssuer: Credential;
  };

};

export class NativeControlPlaneConnectionError extends UserError {
  readonly name = "NativeControlPlaneConnectionError";
}

export function parseNativeControlPlaneConnection(value: unknown): NativeControlPlaneConnection {
  const input = exactRecord(value, ["schemaVersion", "hostId", "nativeGit"]);
  if (input.schemaVersion !== 1) return invalid();
  const hostId = identifier(input.hostId);
  const git = exactRecord(input.nativeGit, ["transport", "endpoint", "serviceId", "generationId",
    "workspaceWriteIssuer", "rootReadIssuer"]);
  if (git.serviceId !== "native-main") return invalid();
  const nativeTransport = transport(git.transport);
  const workspaceWriteIssuer = credential(git.workspaceWriteIssuer);
  const rootReadIssuer = credential(git.rootReadIssuer);
  if (workspaceWriteIssuer.password === rootReadIssuer.password) return invalid();
  const nativeGit = { transport: nativeTransport, endpoint: origin(git.endpoint, nativeTransport),
    serviceId: "native-main" as const, generationId: generation(git.generationId),
    workspaceWriteIssuer, rootReadIssuer };
  return { schemaVersion: 1, hostId, nativeGit };
}

export async function loadNativeControlPlaneConnection(path: string): Promise<NativeControlPlaneConnection> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
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
      const text = bytes.toString("utf8");
      if (hasDuplicateJsonKeys(text)) return invalid();
      value = JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError) return invalid();
      throw error;
    }
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

function credential(value: unknown): Credential {
  const input = exactRecord(value, ["username", "password"]);
  return { username: identifier(input.username), password: token(input.password) };
}

function generation(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) return invalid();
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

function invalid(): never {
  throw new NativeControlPlaneConnectionError("native control-plane host connection is invalid");
}
