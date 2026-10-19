import { createHash, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { NativeGitBundleState } from "./native-bundle-state.js";

export function activationTokenSha256(token: string): string {
  return createHash("sha256").update(Buffer.from(token, "base64url")).digest("hex");
}

export function exactActivationIsBound(
  state: NativeGitBundleState,
  generationId: string,
  activationTokenSha256: string
): boolean {
  const database = new DatabaseSync(state.database, { readOnly: true, defensive: true });
  try {
    const row = database.prepare(
      "SELECT activation_token_sha256 FROM bundle_activation WHERE generation_id = ?"
    ).get(generationId);
    const bound = digestField(row);
    return bound !== undefined && safeDigestEqual(bound, activationTokenSha256);
  } finally {
    database.close();
  }
}

export function bindExactActivation(
  state: NativeGitBundleState,
  generationId: string,
  activationTokenSha256: string
): boolean {
  const database = new DatabaseSync(state.database, { defensive: true });
  try {
    database.exec("PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
    try {
      const bound = digestField(database.prepare(
        "SELECT activation_token_sha256 FROM bundle_activation WHERE generation_id = ?"
      ).get(generationId));
      if (bound !== undefined) {
        if (!safeDigestEqual(bound, activationTokenSha256)) {
          database.exec("ROLLBACK");
          return false;
        }
        database.exec("COMMIT");
        return true;
      }
      if (database.prepare(
        "SELECT 1 FROM bundle_activation WHERE activation_token_sha256 = ?"
      ).get(activationTokenSha256) !== undefined) {
        database.exec("ROLLBACK");
        return false;
      }
      database.prepare(
        "INSERT INTO bundle_activation(generation_id, activation_token_sha256) VALUES (?, ?)"
      ).run(generationId, activationTokenSha256);
      database.exec("COMMIT");
      return true;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function digestField(row: unknown): string | undefined {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return undefined;
  const value = Reflect.get(row, "activation_token_sha256");
  return typeof value === "string" ? value : undefined;
}

function safeDigestEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
