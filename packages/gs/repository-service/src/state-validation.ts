import type { DatabaseSync } from "node:sqlite";
import type { ProtectedRefIntent } from "@slop-lab/gs-repository";
import {
  repositoryBranches,
  repositoryDefaultRef,
  repositoryPolicySchema,
  type RepositoryPolicy,
  type RepositorySelector,
} from "@slop-lab/gs-repository-contracts";
import {
  catalogEntry,
  effectivePolicy,
  listCatalog,
  readBaseline,
  readBaselines,
  readPolicyUpdates,
  type BranchBaseline,
  type CatalogEntry,
} from "./catalog.js";
import { digestSchema, repositoryPolicyDigest } from "./model.js";
import { RepositoryStateError } from "./state.js";
import { readLatestTransition, readTransitions, type StoredTransition } from "./transition-store.js";

export type RepositoryHead = {
  readonly sequence: number;
  readonly protectedRef: string;
  readonly commit: string;
  readonly tree: string;
  readonly policyDigest: string;
};

export function assertDurableState(database: DatabaseSync): void {
  if (database.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new RepositoryStateError("repository state foreign key integrity is invalid");
  }
  const transitions = readTransitions(database);
  const epochs = new Map(database.prepare("SELECT authority_epoch,ref_policy_revision FROM authority_epoch").all().map((row) => {
    if (!isRecord(row) || typeof row.authority_epoch !== "string" || typeof row.ref_policy_revision !== "string") {
      throw new RepositoryStateError("authority epoch record is invalid");
    }
    return [digestSchema.parse(row.authority_epoch), digestSchema.parse(row.ref_policy_revision)] as const;
  }));
  assertServiceMetadata(database, epochs);
  for (const catalog of database.prepare("SELECT DISTINCT namespace_id FROM repository_catalog").all()) {
    if (!isRecord(catalog) || typeof catalog.namespace_id !== "string") throw new RepositoryStateError("repository catalog record is invalid");
    for (const entry of listCatalog(database, catalog.namespace_id)) validateRepository(database, entry, transitions, epochs);
  }
}

export function currentHead(database: DatabaseSync, selector: RepositorySelector & { readonly protectedRef?: string }): RepositoryHead {
  const policy = effectivePolicy(database, selector);
  const protectedRef = selector.protectedRef ?? repositoryDefaultRef(policy.policy);
  if (!Object.hasOwn(repositoryBranches(policy.policy), protectedRef)) throw new RepositoryStateError("repository branch is not managed");
  const baseline = readBaseline(database, selector, protectedRef);
  if (baseline === undefined) throw new RepositoryStateError("repository branch baseline is missing");
  const latest = readLatestTransition(database, selector);
  if (latest !== undefined && !latest.finalized) throw new RepositoryStateError("repository transition recovery is pending");
  const branch = readLatestTransition(database, selector, protectedRef);
  return { sequence: latest?.intent.sequence ?? 0, protectedRef,
    commit: branch?.intent.candidateCommit ?? baseline.seed_commit,
    tree: branch?.intent.candidateTree ?? baseline.seed_tree, policyDigest: policy.policyDigest };
}

export function hasPending(database: DatabaseSync, selector: RepositorySelector): boolean {
  return database.prepare("SELECT 1 FROM repository_ref_transition WHERE namespace_id=? AND repository_id=? AND finalized=0 LIMIT 1")
    .get(selector.namespaceId, selector.repositoryId) !== undefined;
}

export function assertIntentCanAppend(database: DatabaseSync, intent: ProtectedRefIntent): void {
  const catalog = catalogEntryForIntent(database, intent);
  const head = currentHead(database, { namespaceId: intent.namespaceId, repositoryId: intent.repositoryId, protectedRef: intent.protectedRef });
  const epoch = database.prepare("SELECT ref_policy_revision FROM authority_epoch WHERE authority_epoch=?").get(intent.authorityEpoch);
  if (!isRecord(epoch) || epoch.ref_policy_revision !== intent.refPolicyRevision
    || intent.incarnationId !== catalog.incarnation_id || intent.ownerPrincipalId !== catalog.owner_principal_id
    || intent.sequence !== head.sequence + 1 || intent.expectedCommit !== head.commit || intent.expectedTree !== head.tree
    || intent.policyDigest !== head.policyDigest) {
    throw new RepositoryStateError("repository transition intent conflicts with current durable state");
  }
}

function validateRepository(
  database: DatabaseSync,
  catalog: CatalogEntry,
  transitions: readonly StoredTransition[],
  epochs: ReadonlyMap<string, string>,
): void {
  const selector = { namespaceId: catalog.namespace_id, repositoryId: catalog.repository_id };
  const baselines = readBaselines(database, selector);
  const initialPolicy = parseInitialPolicy(catalog.initial_policy_json, catalog.initial_policy_digest);
  const initialBranches = repositoryBranches(initialPolicy);
  if (baselines.length !== Object.keys(initialBranches).length
    || baselines.some((baseline) => !Object.hasOwn(initialBranches, baseline.protected_ref))) {
    throw new RepositoryStateError("repository branch baselines do not match the initial policy");
  }
  const updates = readPolicyUpdates(database, selector);
  const repositoryTransitions = transitions.filter(({ intent }) => sameRepository(intent, selector));
  validatePolicyUpdates(updates, initialPolicy.protectedRef, catalog.initial_policy_digest, baselines, repositoryTransitions);
  const branchHeads = new Map(baselines.map((baseline) => [baseline.protected_ref, baseline]));
  let sequence = 0;
  let pending = false;
  let policyDigest = catalog.initial_policy_digest;
  let updateIndex = 0;
  for (const entry of repositoryTransitions) {
    const intent = entry.intent;
    while (true) {
      const update = updates[updateIndex];
      if (update === undefined || update.head_sequence >= intent.sequence) break;
      policyDigest = update.policy_digest;
      updateIndex += 1;
    }
    const previous = branchHeads.get(intent.protectedRef);
    if (pending || previous === undefined || intent.sequence !== sequence + 1
      || intent.expectedCommit !== previous.seed_commit || intent.expectedTree !== previous.seed_tree
      || intent.incarnationId !== catalog.incarnation_id || intent.ownerPrincipalId !== catalog.owner_principal_id
      || epochs.get(intent.authorityEpoch) !== intent.refPolicyRevision || intent.policyDigest !== policyDigest) {
      throw new RepositoryStateError("repository transition chain is invalid");
    }
    sequence = intent.sequence;
    if (entry.finalized) branchHeads.set(intent.protectedRef, baselineFromIntent(intent));
    else pending = true;
  }
}

function validatePolicyUpdates(
  updates: ReturnType<typeof readPolicyUpdates>,
  protectedRef: string,
  initialDigest: string,
  baselines: readonly BranchBaseline[],
  transitions: readonly StoredTransition[],
): void {
  let previousDigest = initialDigest;
  let revision = 0;
  let protectedHead = baselines.find((entry) => entry.protected_ref === protectedRef)?.seed_commit;
  const protectedHeadBySequence = new Map<number, string>();
  if (protectedHead !== undefined) protectedHeadBySequence.set(0, protectedHead);
  for (const { intent, finalized } of transitions) {
    if (!finalized) continue;
    if (intent.protectedRef === protectedRef) protectedHead = intent.candidateCommit;
    if (protectedHead !== undefined) protectedHeadBySequence.set(intent.sequence, protectedHead);
  }
  for (const update of updates) {
    const branches = repositoryBranches(update.policy);
    if (update.revision !== revision + 1 || update.previous_policy_digest !== previousDigest
      || update.policy.protectedRef !== protectedRef || protectedHeadBySequence.get(update.head_sequence) !== update.head_commit
      || Object.keys(branches).length !== baselines.length
      || Object.keys(branches).some((ref) => !baselines.some((baseline) => baseline.protected_ref === ref))) {
      throw new RepositoryStateError("repository policy update chain is invalid");
    }
    revision = update.revision;
    previousDigest = update.policy_digest;
  }
}

function assertServiceMetadata(database: DatabaseSync, epochs: ReadonlyMap<string, string>): void {
  const rows = database.prepare("SELECT singleton,current_authority_epoch FROM service_metadata").all();
  const row = rows[0];
  if (rows.length !== 1 || !isRecord(row) || row.singleton !== 1 || typeof row.current_authority_epoch !== "string") {
    throw new RepositoryStateError("repository service metadata is invalid");
  }
  const current = digestSchema.parse(row.current_authority_epoch);
  if (epochs.size === 0 ? current !== "0".repeat(64) : !epochs.has(current)) {
    throw new RepositoryStateError("repository service metadata authority epoch is invalid");
  }
}

function parseInitialPolicy(json: string, digest: string): RepositoryPolicy {
  const stored: unknown = JSON.parse(json);
  const policy = repositoryPolicySchema.parse(stored);
  if (JSON.stringify(policy) !== json || repositoryPolicyDigest(policy) !== digest) throw new RepositoryStateError("initial repository policy is invalid");
  return policy;
}

function catalogEntryForIntent(database: DatabaseSync, intent: ProtectedRefIntent): CatalogEntry {
  const entry = catalogEntry(database, intent);
  if (entry === undefined) throw new RepositoryStateError("repository transition has no catalog authority");
  return entry;
}

function baselineFromIntent(intent: StoredTransition["intent"]): BranchBaseline {
  return { namespace_id: intent.namespaceId, repository_id: intent.repositoryId, protected_ref: intent.protectedRef,
    seed_sequence: 0, seed_commit: intent.candidateCommit, seed_tree: intent.candidateTree };
}

function sameRepository(left: RepositorySelector, right: RepositorySelector): boolean {
  return left.namespaceId === right.namespaceId && left.repositoryId === right.repositoryId;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
