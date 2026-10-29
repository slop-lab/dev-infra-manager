import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  repositoryPolicySchema,
  type RepositoryPolicy,
  type RepositorySelector,
} from "@slop-lab/gs-repository-contracts";
import {
  digestSchema,
  objectIdSchema,
  principalIdSchema,
  protectedRefSchema,
  repositoryPolicyDigest,
  selectorSchema,
  type BranchRegistration,
} from "./model.js";
import { RepositoryStateError } from "./state.js";

const catalogRowSchema = z.object({
  namespace_id: z.string(),
  repository_id: z.string(),
  incarnation_id: z.string().uuid(),
  owner_principal_id: principalIdSchema,
  initial_policy_digest: digestSchema,
  initial_policy_json: z.string(),
}).strict();

const baselineRowSchema = z.object({
  namespace_id: z.string(),
  repository_id: z.string(),
  protected_ref: protectedRefSchema,
  seed_sequence: z.literal(0),
  seed_commit: objectIdSchema,
  seed_tree: objectIdSchema,
}).strict();

const policyUpdateRowSchema = z.object({
  namespace_id: z.string(),
  repository_id: z.string(),
  revision: z.number().int().positive(),
  head_sequence: z.number().int().nonnegative(),
  head_commit: objectIdSchema,
  previous_policy_digest: digestSchema,
  policy_digest: digestSchema,
  policy_json: z.string(),
}).strict();

export type CatalogEntry = z.infer<typeof catalogRowSchema>;
export type BranchBaseline = z.infer<typeof baselineRowSchema>;
export type PolicyUpdate = z.infer<typeof policyUpdateRowSchema> & { readonly policy: RepositoryPolicy };
export type EffectivePolicy = { readonly policy: RepositoryPolicy; readonly policyDigest: string };

export function insertRegistration(
  database: DatabaseSync,
  input: {
    readonly selector: RepositorySelector;
    readonly ownerPrincipalId: string;
    readonly policy: RepositoryPolicy;
    readonly branches: readonly BranchRegistration[];
  },
): string {
  const incarnationId = randomUUID();
  const policyJson = JSON.stringify(input.policy);
  const policyDigest = repositoryPolicyDigest(input.policy);
  database.prepare("INSERT INTO repository_catalog VALUES(?,?,?,?,?,?)").run(
    input.selector.namespaceId,
    input.selector.repositoryId,
    incarnationId,
    input.ownerPrincipalId,
    policyDigest,
    policyJson,
  );
  const statement = database.prepare("INSERT INTO repository_branch_baseline VALUES(?,?,?,0,?,?)");
  for (const branch of input.branches) {
    statement.run(input.selector.namespaceId, input.selector.repositoryId, branch.protectedRef, branch.commit, branch.tree);
  }
  return incarnationId;
}

export function appendPolicyUpdate(
  database: DatabaseSync,
  input: {
    readonly selector: RepositorySelector;
    readonly headSequence: number;
    readonly headCommit: string;
    readonly previousPolicyDigest: string;
    readonly policy: RepositoryPolicy;
  },
): void {
  const prior = readLatestPolicyUpdate(database, input.selector);
  const policyJson = JSON.stringify(input.policy);
  database.prepare("INSERT INTO repository_policy_update VALUES(?,?,?,?,?,?,?,?)").run(
    input.selector.namespaceId,
    input.selector.repositoryId,
    (prior?.revision ?? 0) + 1,
    input.headSequence,
    input.headCommit,
    input.previousPolicyDigest,
    repositoryPolicyDigest(input.policy),
    policyJson,
  );
}

export function catalogEntry(database: DatabaseSync, selector: RepositorySelector): CatalogEntry | undefined {
  const row = database.prepare("SELECT * FROM repository_catalog WHERE namespace_id=? AND repository_id=?").get(
    selector.namespaceId,
    selector.repositoryId,
  );
  return row === undefined ? undefined : catalogRowSchema.parse(row);
}

export function listCatalog(database: DatabaseSync, namespaceId: string): readonly CatalogEntry[] {
  return database.prepare("SELECT * FROM repository_catalog WHERE namespace_id=? ORDER BY repository_id").all(namespaceId)
    .map((row) => catalogRowSchema.parse(row));
}

export function listRepositorySelectors(database: DatabaseSync, namespaceId?: string): readonly RepositorySelector[] {
  const rows = namespaceId === undefined
    ? database.prepare("SELECT namespace_id,repository_id FROM repository_catalog ORDER BY namespace_id,repository_id").all()
    : database.prepare("SELECT namespace_id,repository_id FROM repository_catalog WHERE namespace_id=? ORDER BY repository_id").all(namespaceId);
  return rows.map((row) => {
    const parsed = z.object({ namespace_id: z.string(), repository_id: z.string() }).strict().parse(row);
    return selectorSchema.parse({ namespaceId: parsed.namespace_id, repositoryId: parsed.repository_id });
  });
}

export function readBaselines(database: DatabaseSync, selector?: RepositorySelector): readonly BranchBaseline[] {
  const rows = selector === undefined
    ? database.prepare("SELECT * FROM repository_branch_baseline ORDER BY namespace_id,repository_id,protected_ref").all()
    : database.prepare("SELECT * FROM repository_branch_baseline WHERE namespace_id=? AND repository_id=? ORDER BY protected_ref")
      .all(selector.namespaceId, selector.repositoryId);
  return rows.map((row) => baselineRowSchema.parse(row));
}

export function readBaseline(database: DatabaseSync, selector: RepositorySelector, protectedRef: string): BranchBaseline | undefined {
  const row = database.prepare("SELECT * FROM repository_branch_baseline WHERE namespace_id=? AND repository_id=? AND protected_ref=?")
    .get(selector.namespaceId, selector.repositoryId, protectedRef);
  return row === undefined ? undefined : baselineRowSchema.parse(row);
}

export function readPolicyUpdates(database: DatabaseSync, selector?: RepositorySelector): readonly PolicyUpdate[] {
  const rows = selector === undefined
    ? database.prepare("SELECT * FROM repository_policy_update ORDER BY namespace_id,repository_id,revision").all()
    : database.prepare("SELECT * FROM repository_policy_update WHERE namespace_id=? AND repository_id=? ORDER BY revision")
      .all(selector.namespaceId, selector.repositoryId);
  return rows.map((row) => {
    const parsed = policyUpdateRowSchema.parse(row);
    const policy = parseStoredPolicy(parsed.policy_json, parsed.policy_digest);
    return { ...parsed, policy };
  });
}

export function readLatestPolicyUpdate(database: DatabaseSync, selector: RepositorySelector): PolicyUpdate | undefined {
  const row = database.prepare("SELECT * FROM repository_policy_update WHERE namespace_id=? AND repository_id=? ORDER BY revision DESC LIMIT 1")
    .get(selector.namespaceId, selector.repositoryId);
  if (row === undefined) return undefined;
  const parsed = policyUpdateRowSchema.parse(row);
  return { ...parsed, policy: parseStoredPolicy(parsed.policy_json, parsed.policy_digest) };
}

export function effectivePolicy(database: DatabaseSync, selector: RepositorySelector): EffectivePolicy {
  const catalog = catalogEntry(database, selector);
  if (catalog === undefined) throw new RepositoryStateError("repository is not registered");
  const update = readLatestPolicyUpdate(database, selector);
  if (update !== undefined) return { policy: update.policy, policyDigest: update.policy_digest };
  return {
    policy: parseStoredPolicy(catalog.initial_policy_json, catalog.initial_policy_digest),
    policyDigest: catalog.initial_policy_digest,
  };
}

function parseStoredPolicy(json: string, digest: string): RepositoryPolicy {
  const parsed: unknown = JSON.parse(json);
  const policy = repositoryPolicySchema.parse(parsed);
  if (JSON.stringify(policy) !== json || repositoryPolicyDigest(policy) !== digest) {
    throw new RepositoryStateError("repository policy record is invalid");
  }
  return policy;
}
