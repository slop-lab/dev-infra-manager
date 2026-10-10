import { createHash, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { UserError } from "./errors.js";
import type { NativeOrdinaryAuthorityConfig } from "./nativeOrdinaryAuthorityConfig.js";
import { NativeRootAdmissionRequestError } from "./nativeRootAdmissionModel.js";

type ActivationOptions = {
  readonly config: NativeOrdinaryAuthorityConfig;
  readonly readinessToken: string;
  readonly activationToken: string;
};

export function activationGeneration(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 2
    || Reflect.get(value, "schemaVersion") !== 1 || typeof Reflect.get(value, "generationId") !== "string"
    || !/^[0-9a-f]{64}$/.test(String(Reflect.get(value, "generationId")))) {
    throw new NativeRootAdmissionRequestError("activation request is invalid");
  }
  return String(Reflect.get(value, "generationId"));
}

export function bindActivation(database: DatabaseSync, generation: string, digest: string): boolean {
  const generationRow = database.prepare("SELECT activation_token_sha256 FROM bundle_activation WHERE generation_id = ?")
    .get(generation);
  const bound = generationRow === undefined ? undefined : Reflect.get(generationRow, "activation_token_sha256");
  if (typeof bound === "string") return safeEqual(bound, digest);
  if (database.prepare("SELECT 1 FROM bundle_activation WHERE activation_token_sha256 = ?").get(digest) !== undefined) {
    return false;
  }
  database.prepare("INSERT INTO bundle_activation(generation_id, activation_token_sha256) VALUES (?, ?)")
    .run(generation, digest);
  return true;
}

export function activationIsBound(database: DatabaseSync, generation: string, digest: string): boolean {
  return database.prepare(`SELECT 1 FROM bundle_activation
    WHERE generation_id = ? AND activation_token_sha256 = ?`).get(generation, digest) !== undefined;
}

export function assertActivationOptions(options: ActivationOptions, generationId: string): void {
  assertToken(options.readinessToken, "readiness");
  assertToken(options.activationToken, "activation");
  if (!/^[0-9a-f]{64}$/.test(generationId)) throw new UserError("ordinary CI startup generation is invalid");
  const configured = [...Object.values(options.config.credentials).map(({ password }) => password),
    options.config.nativeGit.identity.password, options.config.nativeGit.attemptIssuer.password,
    options.config.nativeGit.resultReporter.password, ...options.config.hosts.map(({ hostToken }) => hostToken)];
  if (options.readinessToken === options.activationToken || configured.includes(options.readinessToken)
    || configured.includes(options.activationToken)) throw new UserError("ordinary CI service tokens must be distinct");
}

export function activationTokenDigest(token: string): string {
  return createHash("sha256").update(Buffer.from(token, "base64url")).digest("hex");
}

function assertToken(value: string, label: string): void {
  const decoded = Buffer.from(value, "base64url");
  if (!/^[A-Za-z0-9_-]+$/.test(value) || decoded.length < 32 || decoded.toString("base64url") !== value) {
    throw new UserError(`ordinary CI ${label} token is invalid`);
  }
}
function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
