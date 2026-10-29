import { createHash } from "node:crypto";
import { chmodSync, lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  decodeDimLegacyMergeAuthorization,
  encodeDimLegacyMergeAuthorization,
} from "./dim-legacy-codec.js";
import {
  mergeAuthorizationSchema,
  mergeAuthorizationRecoveryProofSchema,
  type MergeAuthorization,
  type MergeAuthorizationRecoveryProof,
  type StoredMergeAuthorization,
} from "./model.js";

export * from "./model.js";

export function authorizationIdentity(authorizationInput: MergeAuthorization) {
  const authorization = mergeAuthorizationSchema.parse(authorizationInput);
  const legacy = encodeDimLegacyMergeAuthorization(authorization);
  const evidenceDigest = createHash("sha256")
    .update("dim-merge-policy-evidence-v1\0").update(JSON.stringify(legacy)).digest("hex");
  return {
    authorizationId: createHash("sha256")
      .update("dim-merge-policy-authorization-v1\0").update(evidenceDigest).digest("hex"),
    evidenceDigest,
  };
}

export class MergeAuthorizationStore {
  readonly #database: DatabaseSync;

  constructor(file: string) {
    try {
      const metadata = lstatSync(file);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()
        || (metadata.mode & 0o077) !== 0) throw new MergeAuthorizationStoreError("merge database must be private and owned");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    this.#database = new DatabaseSync(file, { defensive: true });
    try {
      chmodSync(file, 0o600);
      this.#database.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS authorizations (
          id TEXT PRIMARY KEY, evidence TEXT NOT NULL, body TEXT NOT NULL, sequence INTEGER
        ) STRICT;
        CREATE TABLE IF NOT EXISTS authorization_recovery (
          id TEXT PRIMARY KEY, body TEXT NOT NULL
        ) STRICT`);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void { this.#database.close(); }

  prepare(
    authorizationInput: MergeAuthorization,
    recoveryProofInput?: MergeAuthorizationRecoveryProof,
  ): StoredMergeAuthorization {
    const authorization = mergeAuthorizationSchema.parse(authorizationInput);
    const recoveryProof = recoveryProofInput === undefined ? undefined
      : mergeAuthorizationRecoveryProofSchema.parse(recoveryProofInput);
    const identity = authorizationIdentity(authorization);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare("INSERT OR IGNORE INTO authorizations(id,evidence,body) VALUES (?,?,?)")
        .run(identity.authorizationId, identity.evidenceDigest, JSON.stringify(encodeDimLegacyMergeAuthorization(authorization)));
      if (recoveryProof !== undefined) {
        this.#database.prepare("INSERT OR IGNORE INTO authorization_recovery(id,body) VALUES (?,?)")
          .run(identity.authorizationId, JSON.stringify(recoveryProof));
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    const prepared = this.read().find((entry) => entry.authorizationId === identity.authorizationId);
    if (prepared === undefined) throw new MergeAuthorizationStoreError("merge authorization was not persisted");
    if (recoveryProof !== undefined && JSON.stringify(prepared.recoveryProof) !== JSON.stringify(recoveryProof)) {
      throw new MergeAuthorizationStoreError("merge authorization recovery proof conflicts");
    }
    return prepared;
  }

  backfillRecoveryProof(authorizationId: string, proofInput: MergeAuthorizationRecoveryProof): void {
    const proof = mergeAuthorizationRecoveryProofSchema.parse(proofInput);
    this.#database.prepare("INSERT OR IGNORE INTO authorization_recovery(id,body) VALUES (?,?)")
      .run(authorizationId, JSON.stringify(proof));
    const stored = this.read().find((entry) => entry.authorizationId === authorizationId);
    if (stored === undefined || JSON.stringify(stored.recoveryProof) !== JSON.stringify(proof)) {
      throw new MergeAuthorizationStoreError("merge authorization recovery proof conflicts");
    }
  }

  finalize(authorizationId: string, sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new MergeAuthorizationStoreError("invalid merge sequence");
    const row = this.#database.prepare("SELECT sequence FROM authorizations WHERE id=?").get(authorizationId);
    if (row === undefined || (row.sequence !== null && row.sequence !== sequence)) {
      throw new MergeAuthorizationStoreError("merge authorization receipt conflicts");
    }
    this.#database.prepare("UPDATE authorizations SET sequence=? WHERE id=?").run(sequence, authorizationId);
  }

  read(): readonly StoredMergeAuthorization[] {
    return this.#database.prepare(`SELECT a.id,a.evidence,a.body,a.sequence,r.body AS recovery
      FROM authorizations a LEFT JOIN authorization_recovery r ON r.id=a.id ORDER BY a.rowid`).all().map((row) => {
      if (typeof row.body !== "string" || typeof row.id !== "string" || typeof row.evidence !== "string"
        || (row.sequence !== null && (typeof row.sequence !== "number"
          || !Number.isSafeInteger(row.sequence) || row.sequence < 1))
        || (row.recovery !== null && typeof row.recovery !== "string")) {
        throw new MergeAuthorizationStoreError("invalid merge authorization state");
      }
      const authorization = decodeDimLegacyMergeAuthorization(JSON.parse(row.body));
      const identity = authorizationIdentity(authorization);
      if (identity.authorizationId !== row.id || identity.evidenceDigest !== row.evidence) {
        throw new MergeAuthorizationStoreError("merge authorization digest mismatch");
      }
      const recoveryProof = typeof row.recovery === "string"
        ? mergeAuthorizationRecoveryProofSchema.parse(JSON.parse(row.recovery))
        : undefined;
      return { ...identity, authorization,
        ...(recoveryProof === undefined ? {} : { recoveryProof }),
        ...(typeof row.sequence === "number" ? { sequence: row.sequence } : {}) };
    });
  }
}

export class MergeAuthorizationStoreError extends Error {
  readonly name = "MergeAuthorizationStoreError";
}
