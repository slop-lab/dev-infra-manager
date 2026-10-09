import { constants, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";

const connectionFields = [
  "schemaVersion", "endpoint", "serviceId", "hostId", "generationId", "credential"
] as const;
const credentialFields = ["username", "password"] as const;
const maximumConnectionBytes = 16 * 1024;

export type NativeGitProjectRegistrarConnection = {
  readonly schemaVersion: 1;
  readonly endpoint: string;
  readonly serviceId: "native-main";
  readonly hostId: string;
  readonly generationId: string;
  readonly credential: {
    readonly username: string;
    readonly password: string;
  };
};

export async function loadNativeGitProjectRegistrarConnection(
  path: string
): Promise<NativeGitProjectRegistrarConnection> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new NativeGitProjectRegistrarConnectionError("native Git registrar connection file cannot be opened safely");
  }
  try {
    const before = await handle.stat({ bigint: true });
    assertConnectionMetadata(before);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (metadataChanged(before, after) || bytes.length !== Number(before.size)) {
      throw new NativeGitProjectRegistrarConnectionError("native Git registrar connection file changed while being read");
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new NativeGitProjectRegistrarConnectionError("native Git registrar connection file is not valid JSON");
      }
      throw error;
    }
    return parseNativeGitProjectRegistrarConnection(value);
  } finally {
    await handle.close();
  }
}

export function parseNativeGitProjectRegistrarConnection(
  value: unknown
): NativeGitProjectRegistrarConnection {
  const input = exactRecord(value, connectionFields, "native Git registrar connection");
  const credential = exactRecord(input.credential, credentialFields, "native Git registrar credential");
  if (input.schemaVersion !== 1 || input.serviceId !== "native-main") invalid();
  return {
    schemaVersion: 1,
    endpoint: loopbackOrigin(input.endpoint),
    serviceId: "native-main",
    hostId: identifier(input.hostId, "host ID"),
    generationId: generation(input.generationId),
    credential: {
      username: username(credential.username),
      password: password(credential.password)
    }
  };
}

export class NativeGitProjectRegistrarConnectionError extends Error {
  readonly name = "NativeGitProjectRegistrarConnectionError";
}

function assertConnectionMetadata(metadata: BigIntStats): void {
  const owner = process.geteuid?.();
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new NativeGitProjectRegistrarConnectionError("native Git registrar connection must be a regular file");
  }
  if (Number(metadata.mode & 0o777n) !== 0o600) {
    throw new NativeGitProjectRegistrarConnectionError("native Git registrar connection file must have mode 0600");
  }
  if (owner === undefined || metadata.uid !== BigInt(owner)) {
    throw new NativeGitProjectRegistrarConnectionError("native Git registrar connection file has the wrong owner");
  }
  if (metadata.nlink !== 1n) {
    throw new NativeGitProjectRegistrarConnectionError("native Git registrar connection file must have exactly one link");
  }
  if (metadata.size < 1n || metadata.size > BigInt(maximumConnectionBytes)) {
    throw new NativeGitProjectRegistrarConnectionError("native Git registrar connection file size is invalid");
  }
}

function metadataChanged(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.mode !== after.mode
    || before.uid !== after.uid || before.nlink !== after.nlink;
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  label: string
): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || Object.keys(value).length !== fields.length
    || fields.some((field) => !Object.hasOwn(value, field))) {
    throw new NativeGitProjectRegistrarConnectionError(`${label} must contain exactly the required fields`);
  }
  return value;
}

function loopbackOrigin(value: unknown): string {
  if (typeof value !== "string") invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]")
    || url.username !== "" || url.password !== "" || url.pathname !== "/"
    || url.search !== "" || url.hash !== "" || value !== url.origin) {
    throw new NativeGitProjectRegistrarConnectionError("native Git registrar endpoint must be an exact loopback HTTP origin");
  }
  return url.origin;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) {
    throw new NativeGitProjectRegistrarConnectionError(`native Git registrar ${label} is invalid`);
  }
  return value;
}

function username(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(value)) invalid();
  return value;
}

function password(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) invalid();
  return value;
}

function generation(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid();
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new NativeGitProjectRegistrarConnectionError("native Git registrar connection is invalid");
}
