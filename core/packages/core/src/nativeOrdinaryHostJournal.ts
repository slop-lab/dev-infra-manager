import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { parseNativeHostClaimResponse } from "./nativeOrdinaryHostClientProtocol.js";
import { parseNativeHostClaimRequest, parseNativeHostRecoveryRequest, type NativeHostClaim } from "./nativeOrdinaryClaimProtocol.js";
import { parseNativeHostResultRequest } from "./nativeOrdinaryResultProtocol.js";

export type NativeHostPreparedRequest = {
  readonly requestId: string;
  readonly body: string;
};

export type NativeHostJournalState =
  | { readonly kind: "claim"; readonly request: NativeHostPreparedRequest }
  | { readonly kind: "active"; readonly claim: NativeHostClaim }
  | { readonly kind: "result"; readonly claim: NativeHostClaim; readonly request: NativeHostPreparedRequest }
  | { readonly kind: "recovery"; readonly claim: NativeHostClaim; readonly request: NativeHostPreparedRequest };

export class NativeOrdinaryHostJournal {
  readonly #path: string;
  readonly #directory: string;

  constructor(path: string) {
    if (path.length === 0) throw new NativeOrdinaryHostJournalError("native ordinary host journal path is empty");
    this.#path = path;
    this.#directory = dirname(path);
  }

  async load(): Promise<NativeHostJournalState | undefined> {
    await this.#prepareDirectory();
    let metadata;
    try {
      metadata = await lstat(this.#path);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new NativeOrdinaryHostJournalError("native ordinary host journal is not a regular file");
    }
    requireOwnerMode(metadata.uid, metadata.mode, 0o600, "journal");
    const bytes = await readFile(this.#path, "utf8");
    try {
      return parseJournalState(JSON.parse(bytes));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new NativeOrdinaryHostJournalError("native ordinary host journal is not JSON", { cause: error });
      }
      throw error;
    }
  }

  async save(state: NativeHostJournalState): Promise<void> {
    await this.#prepareDirectory();
    const bytes = JSON.stringify({ schemaVersion: 1, ...state });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await chmod(temporary, 0o600);
      await rename(temporary, this.#path);
      await syncDirectory(this.#directory);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async clear(): Promise<void> {
    await this.#prepareDirectory();
    try {
      await unlink(this.#path);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    await syncDirectory(this.#directory);
  }

  async #prepareDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new NativeOrdinaryHostJournalError("native ordinary host journal parent is not a directory");
    }
    requireOwnerMode(metadata.uid, metadata.mode, 0o700, "journal parent");
  }
}

function parseJournalState(value: unknown): NativeHostJournalState {
  const record = exactRecord(value);
  if (record.schemaVersion !== 1) throw new NativeOrdinaryHostJournalError("native ordinary host journal schema is invalid");
  switch (record.kind) {
    case "claim": {
      exactKeys(record, ["schemaVersion", "kind", "request"]);
      const request = parsePreparedRequest(record.request, "claim");
      const parsed = parseBody(request.body, parseNativeHostClaimRequest);
      if (parsed.requestId !== request.requestId) throw new NativeOrdinaryHostJournalError("journal claim request ID is inconsistent");
      return { kind: "claim", request };
    }
    case "active":
      exactKeys(record, ["schemaVersion", "kind", "claim"]);
      return { kind: "active", claim: parseNativeHostClaimResponse(record.claim) };
    case "result": {
      exactKeys(record, ["schemaVersion", "kind", "claim", "request"]);
      const claim = parseNativeHostClaimResponse(record.claim);
      const request = parsePreparedRequest(record.request, "result");
      const parsed = parseBody(request.body, parseNativeHostResultRequest);
      if (parsed.requestId !== request.requestId || parsed.claimId !== claim.claimId) {
        throw new NativeOrdinaryHostJournalError("journal result request is inconsistent");
      }
      return { kind: "result", claim, request };
    }
    case "recovery": {
      exactKeys(record, ["schemaVersion", "kind", "claim", "request"]);
      const claim = parseNativeHostClaimResponse(record.claim);
      const request = parsePreparedRequest(record.request, "recovery");
      const parsed = parseBody(request.body, parseNativeHostRecoveryRequest);
      if (parsed.requestId !== request.requestId || parsed.claimId !== claim.claimId) {
        throw new NativeOrdinaryHostJournalError("journal recovery request is inconsistent");
      }
      return { kind: "recovery", claim, request };
    }
    default:
      throw new NativeOrdinaryHostJournalError("native ordinary host journal kind is invalid");
  }
}

function parsePreparedRequest(value: unknown, label: string): NativeHostPreparedRequest {
  const record = exactRecord(value);
  exactKeys(record, ["requestId", "body"]);
  if (typeof record.requestId !== "string" || typeof record.body !== "string") {
    throw new NativeOrdinaryHostJournalError(`journal ${label} request is invalid`);
  }
  return { requestId: record.requestId, body: record.body };
}

function parseBody<T>(body: string, parser: (value: unknown) => T): T {
  try {
    return parser(JSON.parse(body));
  } catch (error) {
    if (error instanceof SyntaxError) throw new NativeOrdinaryHostJournalError("journal request body is not JSON", { cause: error });
    throw error;
  }
}

function exactRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NativeOrdinaryHostJournalError("native ordinary host journal record is invalid");
  }
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}

function exactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  if (Object.keys(record).length !== keys.length || keys.some((key) => record[key] === undefined)) {
    throw new NativeOrdinaryHostJournalError("native ordinary host journal fields are invalid");
  }
}

function requireOwnerMode(uid: number, mode: number, required: number, label: string): void {
  const getuid = process.getuid;
  if (getuid === undefined || uid !== getuid() || (mode & 0o777) !== required) {
    throw new NativeOrdinaryHostJournalError(`native ordinary host ${label} ownership or mode is invalid`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

export class NativeOrdinaryHostJournalError extends Error {
  readonly name = "NativeOrdinaryHostJournalError";
}
