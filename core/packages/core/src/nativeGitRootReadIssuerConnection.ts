import { constants, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";

const connectionFields = [
  "schemaVersion", "endpoint", "serviceId", "role", "hostId", "generationId", "credential"
] as const;
const credentialFields = ["username", "password"] as const;
const maximumConnectionBytes = 16 * 1024;

export type NativeGitRootReadIssuerConnection = {
  readonly schemaVersion: 1;
  readonly endpoint: string;
  readonly serviceId: "native-main";
  readonly role: "operator-root-read-issuer";
  readonly hostId: string;
  readonly generationId: string;
  readonly credential: {
    readonly username: string;
    readonly password: string;
  };
};

export class NativeGitRootReadIssuerConnectionError extends Error {
  readonly name = "NativeGitRootReadIssuerConnectionError";
}

export async function loadNativeGitRootReadIssuerConnection(
  path: string
): Promise<NativeGitRootReadIssuerConnection> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new NativeGitRootReadIssuerConnectionError("native Git root read issuer connection file cannot be opened safely");
  }
  try {
    const before = await handle.stat({ bigint: true });
    assertFileMetadata(before);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (metadataChanged(before, after) || bytes.length !== Number(before.size)) {
      throw new NativeGitRootReadIssuerConnectionError("native Git root read issuer connection file changed while being read");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new NativeGitRootReadIssuerConnectionError("native Git root read issuer connection file is not valid JSON");
      }
      throw error;
    }
    return parseNativeGitRootReadIssuerConnection(parsed);
  } finally {
    await handle.close();
  }
}

export function parseNativeGitRootReadIssuerConnection(input: unknown): NativeGitRootReadIssuerConnection {
  const record = exactRecord(input, connectionFields);
  const credential = exactRecord(record.credential, credentialFields);
  if (record.schemaVersion !== 1 || record.serviceId !== "native-main"
    || record.role !== "operator-root-read-issuer") invalid();
  return {
    schemaVersion: 1,
    endpoint: loopbackOrigin(record.endpoint),
    serviceId: "native-main",
    role: "operator-root-read-issuer",
    hostId: identifier(record.hostId),
    generationId: generation(record.generationId),
    credential: {
      username: username(credential.username),
      password: password(credential.password)
    }
  };
}

function assertFileMetadata(metadata: BigIntStats): void {
  const owner = process.geteuid?.();
  if (!metadata.isFile() || metadata.isSymbolicLink() || Number(metadata.mode & 0o777n) !== 0o600
    || owner === undefined || metadata.uid !== BigInt(owner) || metadata.nlink !== 1n
    || metadata.size < 1n || metadata.size > BigInt(maximumConnectionBytes)) {
    throw new NativeGitRootReadIssuerConnectionError("native Git root read issuer connection requires an owner-only regular file");
  }
}

function metadataChanged(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.mode !== after.mode
    || before.uid !== after.uid || before.nlink !== after.nlink;
}

function exactRecord(input: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(input) || Object.keys(input).length !== fields.length
    || fields.some((field) => !Object.hasOwn(input, field))) invalid();
  return input;
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function loopbackOrigin(input: unknown): string {
  if (typeof input !== "string") invalid();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return invalid();
  }
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]")
    || url.username !== "" || url.password !== "" || url.pathname !== "/"
    || url.search !== "" || url.hash !== "" || input !== url.origin) invalid();
  return url.origin;
}

function identifier(input: unknown): string {
  if (typeof input !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input)) invalid();
  return input;
}

function generation(input: unknown): string {
  if (typeof input !== "string" || !/^[0-9a-f]{64}$/.test(input)) invalid();
  return input;
}

function username(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(input)) invalid();
  return input;
}

function password(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9_-]+$/.test(input)) invalid();
  const decoded = Buffer.from(input, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== input) invalid();
  return input;
}

function invalid(): never {
  throw new NativeGitRootReadIssuerConnectionError("native Git root read issuer connection is invalid");
}
