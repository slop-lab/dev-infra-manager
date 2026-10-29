import type { DatabaseSync } from "node:sqlite";
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
  readBaselines,
  readPolicyUpdates,
  type BranchBaseline,
  type CatalogEntry,
} from "./catalog.js";
import { digestSchema, repositoryPolicyDigest } from "./model.js";
import { RepositoryStateError } from "./state.js";
import { readTransitions, type StoredTransition } from "./transition-store.js";

export type RepositoryHead = {
  readonly sequence: number;
  readonly protectedRef: string;
  readonly commit: string;
  readonly tree: string;
  readonly policyDigest: string;
};

export function assertDurableState(database: DatabaseSync): void {
  const transitions = readTransitions(database);
  const epochs = new Map(database.prepare("SELECT authority_epoch,ref_policy_revision FROM authority_epoch").all().map((row) => {
    if (!isRecord(row) || typeof row.authority_epoch !== "string" || typeof row.ref_policy_revision !== "string") {
      throw new RepositoryStateError("authority epoch record is invalid");
    }
    return [digestSchema.parse(row.authority_epoch), digestSchema.parse(row.ref_policy_revision)] as const;
  }));
  for (const catalog of database.prepare("SELECT DISTINCT namespace_id FROM repository_catalog").all()) {
    if (!isRecord(catalog) || typeof catalog.namespace_id !== "string") throw new RepositoryStateError("repository catalog record is invalid");
    for (const entry of listCatalog(database, catalog.namespace_id)) validateRepository(database, entry, transitions, epochs);
  }
}

export function currentHead(database: DatabaseSync, selector: RepositorySelector & { readonly protectedRef?: string }): RepositoryHead {
  assertDurableState(database);
  const policy = effectivePolicy(database, selector);
  const protectedRef = selector.protectedRef ?? repositoryDefaultRef(policy.policy);
  if (!Object.hasOwn(repositoryBranches(policy.policy), protectedRef)) throw new RepositoryStateError("repository branch is not managed");
  const baseline = readBaselines(database, selector).find((entry) => entry.protected_ref === protectedRef);
  if (baseline === undefined) throw new RepositoryStateError("repository branch baseline is missing");
  let commit = baseline.seed_commit;
  let tree = baseline.seed_tree;
  let sequence = 0;
  for (const entry of readTransitions(database).filter(({ intent }) => sameRepository(intent, selector))) {
    if (!entry.finalized) throw new RepositoryStateError("repository transition recovery is pending");
    sequence = entry.intent.sequence;
    if (entry.intent.protectedRef === protectedRef) {
      commit = entry.intent.candidateCommit;
      tree = entry.intent.candidateTree;
    }
  }
  return { sequence, protectedRef, commit, tree, policyDigest: policy.policyDigest };
}

export function hasPending(database: DatabaseSync, selector: RepositorySelector): boolean {
  return readTransitions(database).some(({ intent, finalized }) => !finalized && sameRepository(intent, selector));
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
  validatePolicyUpdates(readPolicyUpdates(database, selector), initialPolicy.protectedRef,
    catalog.initial_policy_digest, baselines, transitions, selector);
  const branchHeads = new Map(baselines.map((baseline) => [baseline.protected_ref, baseline]));
  let sequence = 0;
  let pending = false;
  for (const entry of transitions.filter(({ intent }) => sameRepository(intent, selector))) {
    const intent = entry.intent;
    const policy = effectivePolicyAtSequence(database, selector, intent.sequence);
    const previous = branchHeads.get(intent.protectedRef);
    if (pending || previous === undefined || intent.sequence !== sequence + 1
      || intent.expectedCommit !== previous.seed_commit || intent.expectedTree !== previous.seed_tree
      || intent.incarnationId !== catalog.incarnation_id || intent.ownerPrincipalId !== catalog.owner_principal_id
      || epochs.get(intent.authorityEpoch) !== intent.refPolicyRevision || intent.policyDigest !== policy.policyDigest) {
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
  selector: RepositorySelector,
): void {
  let previousDigest = initialDigest;
  let revision = 0;
  for (const update of updates) {
    const prior = transitions.filter(({ intent, finalized }) => finalized && sameRepository(intent, selector) && intent.sequence <= update.head_sequence);
    const cursor = prior.at(-1)?.intent.sequence ?? 0;
    const head = prior.filter(({ intent }) => intent.protectedRef === protectedRef).at(-1)?.intent.candidateCommit
      ?? baselines.find((entry) => entry.protected_ref === protectedRef)?.seed_commit;
    const branches = repositoryBranches(update.policy);
    if (update.revision !== revision + 1 || update.previous_policy_digest !== previousDigest
      || update.policy.protectedRef !== protectedRef || cursor !== update.head_sequence || head !== update.head_commit
      || Object.keys(branches).some((ref) => !baselines.some((baseline) => baseline.protected_ref === ref))) {
      throw new RepositoryStateError("repository policy update chain is invalid");
    }
    revision = update.revision;
    previousDigest = update.policy_digest;
  }
}

function effectivePolicyAtSequence(database: DatabaseSync, selector: RepositorySelector, sequence: number) {
  const catalog = catalogEntry(database, selector);
  if (catalog === undefined) throw new RepositoryStateError("repository is not registered");
  const update = readPolicyUpdates(database, selector).filter((entry) => entry.head_sequence < sequence).at(-1);
  return update === undefined
    ? { policy: parseInitialPolicy(catalog.initial_policy_json, catalog.initial_policy_digest), policyDigest: catalog.initial_policy_digest }
    : { policy: update.policy, policyDigest: update.policy_digest };
}

function parseInitialPolicy(json: string, digest: string): RepositoryPolicy {
  const stored: unknown = JSON.parse(json);
  const policy = repositoryPolicySchema.parse(stored);
  if (JSON.stringify(policy) !== json || repositoryPolicyDigest(policy) !== digest) throw new RepositoryStateError("initial repository policy is invalid");
  return policy;
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
