import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { parseNativeJobAttemptIssuance, type NativeJobAttemptIssuance } from "./nativeGitAttemptIssuerModel.js";
import {
  parseNativeRootCiActiveClaim,
  parseNativeRootCiClaimActivationRequest,
  parseNativeRootCiClaimRecoveryRequest,
  type NativeRootCiActiveClaim
} from "./nativeRootCiClaimLifecycleProtocol.js";
import { parseNativeRootCiClaim, parseNativeRootCiClaimRequest,
  type NativeRootCiClaim } from "./nativeRootCiClaimProtocol.js";
import { parseNativeRootCiHostResultRequest } from "./nativeRootCiResultProtocol.js";
import {
  NativeHostPrivateRoot,
  parseNativeHostPrivateRootIdentity,
  type NativeHostPrivateRootIdentity
} from "./nativeOrdinaryExecutorRoot.js";
import type { NativeRootCiHostPreparedRequest } from "./nativeRootCiHostClient.js";

export type NativeRootCiHostJournalState =
  | { readonly kind: "claim"; readonly request: NativeRootCiHostPreparedRequest }
  | { readonly kind: "reserved"; readonly claim: NativeRootCiClaim }
  | { readonly kind: "activation"; readonly claim: NativeRootCiClaim; readonly issuance: NativeJobAttemptIssuance;
    readonly request: NativeRootCiHostPreparedRequest }
  | { readonly kind: "active"; readonly claim: NativeRootCiClaim; readonly active: NativeRootCiActiveClaim;
    readonly privateRoot: NativeHostPrivateRootIdentity }
  | { readonly kind: "result"; readonly claim: NativeRootCiClaim; readonly active: NativeRootCiActiveClaim;
    readonly privateRoot: NativeHostPrivateRootIdentity; readonly request: NativeRootCiHostPreparedRequest }
  | { readonly kind: "recovery"; readonly claim: NativeRootCiClaim; readonly active: NativeRootCiActiveClaim;
    readonly privateRoot: NativeHostPrivateRootIdentity; readonly request: NativeRootCiHostPreparedRequest };

export class NativeRootCiHostJournal {
  readonly #path: string;
  readonly #directory: string;

  constructor(path: string) {
    if (path.length === 0) throw new NativeRootCiHostJournalError("native root CI host journal path is empty");
    this.#path = path;
    this.#directory = dirname(path);
  }

  async prepare(): Promise<void> {
    await this.#prepareDirectory();
  }

  async load(): Promise<NativeRootCiHostJournalState | undefined> {
    await this.#prepareDirectory();
    let metadata;
    try { metadata = await lstat(this.#path); }
    catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) invalid("journal is not a regular file");
    requireOwnerMode(metadata.uid, metadata.mode, 0o600, "journal");
    try { return parseState(JSON.parse(await readFile(this.#path, "utf8"))); }
    catch (error) {
      if (error instanceof SyntaxError) {
        throw new NativeRootCiHostJournalError("native root CI host journal is not JSON", { cause: error });
      }
      throw error;
    }
  }

  async save(state: NativeRootCiHostJournalState): Promise<void> {
    await this.#prepareDirectory();
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, ...state }), "utf8");
      await handle.sync();
    } finally { await handle.close(); }
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
    try { await unlink(this.#path); }
    catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    await syncDirectory(this.#directory);
  }

  privateRoot(identity: NativeHostPrivateRootIdentity): NativeHostPrivateRoot {
    return new NativeHostPrivateRoot(this.#directory, identity);
  }

  async #prepareDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid("journal parent is not a directory");
    requireOwnerMode(metadata.uid, metadata.mode, 0o700, "journal parent");
  }
}

function parseState(value: unknown): NativeRootCiHostJournalState {
  const record = exactRecord(value);
  if (record.schemaVersion !== 1) invalid("journal schema is invalid");
  switch (record.kind) {
    case "claim": {
      exactKeys(record, ["schemaVersion", "kind", "request"]);
      const request = parseRequest(record.request, parseNativeRootCiClaimRequest);
      return { kind: "claim", request };
    }
    case "reserved":
      exactKeys(record, ["schemaVersion", "kind", "claim"]);
      return { kind: "reserved", claim: parseNativeRootCiClaim(record.claim) };
    case "activation": {
      exactKeys(record, ["schemaVersion", "kind", "claim", "issuance", "request"]);
      const claim = parseNativeRootCiClaim(record.claim);
      const issuance = parseNativeJobAttemptIssuance(record.issuance);
      const request = parseRequest(record.request, parseNativeRootCiClaimActivationRequest);
      return { kind: "activation", claim, issuance, request };
    }
    case "active": {
      exactKeys(record, ["schemaVersion", "kind", "claim", "active", "privateRoot"]);
      return { kind: "active", claim: parseNativeRootCiClaim(record.claim),
        active: parseNativeRootCiActiveClaim(record.active), privateRoot: privateRoot(record.privateRoot) };
    }
    case "result":
      return parseFinalState(record, "result", parseNativeRootCiHostResultRequest);
    case "recovery":
      return parseFinalState(record, "recovery", parseNativeRootCiClaimRecoveryRequest);
    default:
      return invalid("journal kind is invalid");
  }
}

function parseFinalState(
  record: Readonly<Record<string, unknown>>,
  kind: "result" | "recovery",
  parser: (value: unknown) => { readonly requestId: string }
): Extract<NativeRootCiHostJournalState, { readonly kind: typeof kind }> {
  exactKeys(record, ["schemaVersion", "kind", "claim", "active", "privateRoot", "request"]);
  return { kind, claim: parseNativeRootCiClaim(record.claim), active: parseNativeRootCiActiveClaim(record.active),
    privateRoot: privateRoot(record.privateRoot), request: parseRequest(record.request, parser) };
}

function parseRequest<T extends { readonly requestId: string }>(value: unknown,
  parser: (input: unknown) => T): NativeRootCiHostPreparedRequest {
  const record = exactRecord(value);
  exactKeys(record, ["requestId", "body"]);
  if (typeof record.requestId !== "string" || typeof record.body !== "string") invalid("journal request is invalid");
  let parsed: T;
  try { parsed = parser(JSON.parse(record.body)); }
  catch (error) {
    if (error instanceof SyntaxError) invalid("journal request body is not JSON");
    throw error;
  }
  if (parsed.requestId !== record.requestId) invalid("journal request ID is inconsistent");
  return { requestId: record.requestId, body: record.body };
}

function privateRoot(value: unknown): NativeHostPrivateRootIdentity {
  try { return parseNativeHostPrivateRootIdentity(value); }
  catch (error) { throw new NativeRootCiHostJournalError("journal private root identity is invalid", { cause: error }); }
}

function exactRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("journal record is invalid");
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}

function exactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    invalid("journal fields are invalid");
  }
}

function requireOwnerMode(uid: number, mode: number, required: number, label: string): void {
  const owner = process.getuid?.();
  if (owner === undefined || uid !== owner || (mode & 0o777) !== required) invalid(`${label} ownership or mode is invalid`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

function invalid(message: string): never { throw new NativeRootCiHostJournalError(`native root CI host ${message}`); }

export class NativeRootCiHostJournalError extends Error {
  readonly name = "NativeRootCiHostJournalError";
}
