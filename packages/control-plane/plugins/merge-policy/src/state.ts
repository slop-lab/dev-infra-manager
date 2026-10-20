import { createHash } from "node:crypto";
import { chmodSync, lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), digest = z.string().regex(/^[0-9a-f]{64}$/);
const attachment = z.object({ kind: z.string(), id: z.string(), digest }).strict().readonly();
export const mergeAuthorizationSchema = z.object({ projectId: identifier, repositoryId: identifier,
  reviewId: digest, generationId: digest, envelopeId: digest, policyDigest: digest,
  protectedRef: z.string(), proposalRef: z.string(), expectedCommit: z.string(), candidateCommit: z.string(), candidateTree: z.string(),
  approvals: z.array(z.object({ reviewerId: identifier, recordDigest: digest }).strict()).readonly(),
  attachments: z.array(attachment).readonly() }).strict().readonly();
export type MergeAuthorization = z.infer<typeof mergeAuthorizationSchema>;
export type StoredMergeAuthorization = { readonly authorizationId: string; readonly evidenceDigest: string; readonly authorization: MergeAuthorization; readonly sequence?: number };
export function authorizationIdentity(authorization: MergeAuthorization) {
  const evidenceDigest = createHash("sha256").update("dim-merge-policy-evidence-v1\0").update(JSON.stringify(authorization)).digest("hex");
  return { authorizationId: createHash("sha256").update("dim-merge-policy-authorization-v1\0").update(evidenceDigest).digest("hex"), evidenceDigest };
}
/** Merge evidence is separate from the repository's neutral accepted CAS journal. */
export class MergeAuthorizationStore {
  private readonly database: DatabaseSync;
  constructor(file: string) {
    try { const metadata = lstatSync(file); if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) throw new Error("merge authorization database must be private and owned"); }
    catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
    this.database = new DatabaseSync(file, { defensive: true });
    try { chmodSync(file, 0o600); this.database.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS authorizations (id TEXT PRIMARY KEY, evidence TEXT NOT NULL, body TEXT NOT NULL, sequence INTEGER) STRICT`); }
    catch (error) { this.database.close(); throw error; }
  }
  close(): void { this.database.close(); }
  prepare(authorization: MergeAuthorization): StoredMergeAuthorization {
    const value = mergeAuthorizationSchema.parse(authorization), { authorizationId, evidenceDigest } = authorizationIdentity(value), body = JSON.stringify(value);
    this.database.prepare("INSERT OR IGNORE INTO authorizations(id,evidence,body) VALUES (?,?,?)").run(authorizationId, evidenceDigest, body);
    return this.read().find((entry) => entry.authorizationId === authorizationId)!;
  }
  finalize(authorizationId: string, sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("invalid merge sequence");
    const row = this.database.prepare("SELECT sequence FROM authorizations WHERE id=?").get(authorizationId);
    if (!row || row.sequence !== null && row.sequence !== sequence) throw new Error("merge authorization receipt conflicts");
    this.database.prepare("UPDATE authorizations SET sequence=? WHERE id=?").run(sequence, authorizationId);
  }
  read(): readonly StoredMergeAuthorization[] {
    return this.database.prepare("SELECT id,evidence,body,sequence FROM authorizations ORDER BY rowid").all().map((row) => {
      if (typeof row.body !== "string" || typeof row.id !== "string" || typeof row.evidence !== "string"
        || row.sequence !== null && (typeof row.sequence !== "number" || !Number.isSafeInteger(row.sequence) || row.sequence < 1)) throw new Error("invalid merge authorization state");
      const authorization = mergeAuthorizationSchema.parse(JSON.parse(row.body)), identity = authorizationIdentity(authorization);
      if (identity.authorizationId !== row.id || identity.evidenceDigest !== row.evidence) throw new Error("merge authorization digest mismatch");
      return { ...identity, authorization, ...(typeof row.sequence === "number" ? { sequence: row.sequence } : {}) };
    });
  }
}
