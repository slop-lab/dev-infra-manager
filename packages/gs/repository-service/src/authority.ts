import type { DatabaseSync } from "node:sqlite";
import { assertGitExecutableIdentity, compareAndSwapProtectedRef, parseProtectedRefFinalizedQuery, recoverProtectedRefChanges, type GitExecutableIdentity, type GitRepositoryRuntime, type ProtectedRefChange, type ProtectedRefFinalized, type ProtectedRefFinalizedQuery, type ProtectedRefPorts, type ProtectedRefReceipt } from "@slop-lab/gs-repository";
import { repositoryBranches, type Namespace, type RepositorySelector } from "@slop-lab/gs-repository-contracts";
import { RepositoryAdmission } from "./admission.js";
import { appendPolicyUpdate, catalogEntry, effectivePolicy, insertRegistration, listCatalog, listRepositorySelectors, readBaselines } from "./catalog.js";
import { BorrowedRepositoryMutationAuthorityHandle, BorrowedRepositoryReadAuthorityHandle, type BorrowedReadOperations } from "./borrowed-authority.js";
import { createJournalPort } from "./journal.js";
import { newAuthorityEpoch, registerRepositorySchema, replacePolicySchema, type RegisterRepositoryInput, type ReplaceRepositoryPolicyInput } from "./model.js";
import { acquireStateOwner, type StateOwner } from "./owner.js";
import { assertPolicyCapabilities, assertStoredPolicyCapabilities } from "./policy-capabilities.js";
import { authorizeRefUpdatePolicies, selectedRefUpdatePolicyRevision } from "./ref-update-policy.js";
import type { RefUpdatePolicy, BorrowedRepositoryMutationAccess, BorrowedRepositoryMutationAuthority, BorrowedRepositoryReadAccess, PolicySectionOwner, RepositoryAuthority, RepositoryAvailability, RepositoryExclusiveGate, RepositoryMutationGate, RepositoryReadGate, RepositoryTarget, RepositoryTargetSelector } from "./ports.js";
import { initializeAuthorityEpoch, openStateDatabase, RepositoryStateError, transaction } from "./state.js";
import { assertDurableState, currentHead, hasPending } from "./state-validation.js";
import { RepositoryTargetOwner } from "./target-owner.js";

export type RepositoryAuthorityOptions = {
  readonly statePath: string;
  readonly runtime: GitRepositoryRuntime;
  readonly gitIdentity: GitExecutableIdentity;
  readonly refUpdatePolicies: readonly RefUpdatePolicy[];
  readonly policySectionOwners?: readonly PolicySectionOwner[];
};

export async function openRepositoryAuthority(options: RepositoryAuthorityOptions): Promise<DurableRepositoryAuthority> {
  const refPolicyRevision = selectedRefUpdatePolicyRevision(options.refUpdatePolicies);
  await assertGitExecutableIdentity(options.runtime.gitExecutable, options.gitIdentity);
  const owner = await acquireStateOwner(options.statePath);
  let database: DatabaseSync | undefined;
  try {
    database = await openStateDatabase(options.statePath, owner.createState);
    assertDurableState(database);
    assertStoredPolicyCapabilities(database, options.policySectionOwners ?? [], options.refUpdatePolicies);
    const epoch = newAuthorityEpoch();
    initializeAuthorityEpoch(database, epoch, refPolicyRevision);
    const authority = new DurableRepositoryAuthority(options, { owner, database, epoch, refPolicyRevision });
    await authority.recover();
    return authority;
  } catch (error) {
    database?.close();
    owner.release();
    throw error;
  }
}

export class DurableRepositoryAuthority implements RepositoryAuthority, RepositoryReadGate, RepositoryMutationGate, RepositoryExclusiveGate {
  readonly authorityEpoch: string;
  readonly #owner: StateOwner;
  readonly #database: DatabaseSync;
  readonly #ports: ProtectedRefPorts;
  readonly #borrowedPorts: ProtectedRefPorts;
  readonly #targets: RepositoryTargetOwner;
  readonly #admission = new RepositoryAdmission();
  readonly #refUpdatePolicies: readonly RefUpdatePolicy[];
  readonly #policySectionOwners: readonly PolicySectionOwner[];

  constructor(options: RepositoryAuthorityOptions, resources: {
    readonly owner: StateOwner;
    readonly database: DatabaseSync;
    readonly epoch: string;
    readonly refPolicyRevision: string;
  }) {
    this.#owner = resources.owner;
    this.#database = resources.database;
    this.authorityEpoch = resources.epoch;
    this.#refUpdatePolicies = options.refUpdatePolicies;
    this.#policySectionOwners = options.policySectionOwners ?? [];
    this.#targets = new RepositoryTargetOwner({
      runtime: options.runtime,
      gitIdentity: options.gitIdentity,
      database: resources.database,
      epoch: resources.epoch,
      expectedRefPolicyRevision: resources.refPolicyRevision,
      currentRefPolicyRevision: () => selectedRefUpdatePolicyRevision(options.refUpdatePolicies),
    });
    const ports: Omit<ProtectedRefPorts, "serialization"> = {
      runtime: options.runtime,
      gitIdentity: options.gitIdentity,
      journal: createJournalPort(resources.database),
      targets: {
        resolve: (change) => this.#targets.resolveCore({
          namespaceId: change.namespaceId,
          repositoryId: change.repositoryId,
          ...(change.protectedRef === undefined ? {} : { protectedRef: change.protectedRef }),
        }),
        assertCurrent: (target) => this.#targets.assertCurrent(target),
        locateForRecovery: (intent) => this.#targets.locateForRecovery(intent),
      },
      policy: {
        authorize: async ({ change, target }) => {
          const current = effectivePolicy(this.#database, target.selector);
          if (current.policyDigest !== target.policyDigest) throw new RepositoryStateError("repository policy changed during authorization");
          const borrowed = new BorrowedRepositoryReadAuthorityHandle(this.#borrowedReadOperations());
          try {
            const refPolicyRevision = await authorizeRefUpdatePolicies(options.refUpdatePolicies, resources.refPolicyRevision,
              { authority: borrowed, change, target, policy: current.policy });
            return { refPolicyRevision };
          } finally { await borrowed.drainAndRevoke(); }
        },
      },
    };
    this.#ports = {
      ...ports,
      serialization: { kind: "exclusive", runExclusive: (operation) => this.#withExclusive(operation) },
    };
    this.#borrowedPorts = { ...ports, serialization: { kind: "already-exclusive" } };
  }

  async registerRepository(input: RegisterRepositoryInput): Promise<RepositoryTarget> {
    const registration = registerRepositorySchema.parse(input);
    return this.#withExclusive(async () => {
      assertPolicyCapabilities(registration.policy, this.#policySectionOwners, this.#refUpdatePolicies);
      if (catalogEntry(this.#database, registration.selector) !== undefined) throw new RepositoryStateError("repository is already registered");
      const declared = repositoryBranches(registration.policy);
      const refs = new Set(registration.branches.map((branch) => branch.protectedRef));
      if (refs.size !== registration.branches.length || refs.size !== Object.keys(declared).length
        || Object.keys(declared).some((ref) => !refs.has(ref))) {
        throw new RepositoryStateError("registered branch baselines must exactly match repository policy");
      }
      for (const branch of registration.branches) {
        await this.#targets.assertGitHead(registration.selector, branch.protectedRef, branch.commit, branch.tree);
      }
      transaction(this.#database, () => {
        insertRegistration(this.#database, registration);
        assertDurableState(this.#database);
      });
      return this.#targets.resolve(registration.selector);
    });
  }

  async replacePolicy(input: ReplaceRepositoryPolicyInput): Promise<RepositoryTarget> {
    const replacement = replacePolicySchema.parse(input);
    return this.#withExclusive(async () => {
      assertPolicyCapabilities(replacement.policy, this.#policySectionOwners, this.#refUpdatePolicies);
      assertDurableState(this.#database);
      if (hasPending(this.#database, replacement.selector)) throw new RepositoryStateError("repository transition recovery is pending");
      const current = effectivePolicy(this.#database, replacement.selector);
      const head = currentHead(this.#database, { ...replacement.selector, protectedRef: current.policy.protectedRef });
      const baselines = readBaselines(this.#database, replacement.selector);
      const branches = repositoryBranches(replacement.policy);
      if (current.policyDigest !== replacement.expectedPolicyDigest || head.commit !== replacement.expectedProtectedHead
        || replacement.policy.protectedRef !== current.policy.protectedRef
        || Object.keys(branches).length !== baselines.length
        || Object.keys(branches).some((ref) => !baselines.some((baseline) => baseline.protected_ref === ref))) {
        throw new RepositoryStateError("repository policy compare-and-swap conflicts");
      }
      transaction(this.#database, () => {
        appendPolicyUpdate(this.#database, {
          selector: replacement.selector,
          headSequence: head.sequence,
          headCommit: head.commit,
          previousPolicyDigest: current.policyDigest,
          policy: replacement.policy,
        });
        assertDurableState(this.#database);
      });
      return this.#targets.resolve(replacement.selector);
    });
  }

  promote(change: ProtectedRefChange): Promise<ProtectedRefReceipt> {
    if (!this.#admission.accepting()) return Promise.reject(new RepositoryStateError("repository authority is closing or closed"));
    return compareAndSwapProtectedRef(this.#ports, change);
  }

  recover(): Promise<void> {
    if (!this.#admission.accepting()) return Promise.reject(new RepositoryStateError("repository authority is closing or closed"));
    return recoverProtectedRefChanges(this.#ports);
  }

  resolve(selector: RepositoryTargetSelector): Promise<RepositoryTarget> {
    return this.#withExclusive(() => this.#targets.resolve(selector));
  }

  assertCurrent(target: RepositoryTarget): Promise<void> {
    return this.#withExclusive(() => this.#targets.assertCurrent(target));
  }

  list(namespace: Namespace): Promise<readonly RepositoryTarget[]> {
    return this.#withExclusive(() => this.#listNow(namespace));
  }

  listSelectors(namespace?: Namespace): Promise<readonly RepositorySelector[]> {
    return this.#withExclusive(() => this.#listSelectorsNow(namespace));
  }

  availability(selector: RepositoryTargetSelector): Promise<RepositoryAvailability> {
    return this.#withExclusive(() => this.#availabilityNow(selector));
  }

  findFinalized(query: ProtectedRefFinalizedQuery): Promise<ProtectedRefFinalized | undefined> {
    return this.#withRead(() => this.#findFinalizedNow(query));
  }

  read<Result>(selector: RepositoryTargetSelector, operation: (access: BorrowedRepositoryReadAccess) => Promise<Result>): Promise<Result> {
    return this.#withRead(async () => {
      const borrowed = new BorrowedRepositoryReadAuthorityHandle(this.#borrowedReadOperations());
      try {
        return await operation({ authority: borrowed, target: await borrowed.resolve(selector) });
      } finally {
        await borrowed.drainAndRevoke();
      }
    });
  }

  mutate<Result>(selector: RepositoryTargetSelector, operation: (access: BorrowedRepositoryMutationAccess) => Promise<Result>): Promise<Result> {
    return this.exclusive(async (authority) => operation({ authority, target: await authority.resolve(selector) }));
  }

  exclusive<Result>(operation: (authority: BorrowedRepositoryMutationAuthority) => Promise<Result>): Promise<Result> {
    return this.#withExclusive(async () => {
      const borrowed = new BorrowedRepositoryMutationAuthorityHandle({
        ...this.#borrowedReadOperations(),
        promote: (change) => compareAndSwapProtectedRef(this.#borrowedPorts, change),
      });
      try {
        return await operation(borrowed);
      } finally {
        await borrowed.drainAndRevoke();
      }
    });
  }

  #withExclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.#admission.runExclusive(operation);
  }

  #withRead<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.#admission.runRead(operation);
  }

  #borrowedReadOperations(): BorrowedReadOperations {
    return {
      authorityEpoch: this.authorityEpoch,
      resolve: (selector) => this.#targets.resolve(selector),
      assertCurrent: (target) => this.#targets.assertCurrent(target),
      list: (namespace) => this.#listNow(namespace),
      listSelectors: (namespace) => this.#listSelectorsNow(namespace),
      availability: (selector) => this.#availabilityNow(selector),
      findFinalized: (query) => this.#findFinalizedNow(query),
    };
  }

  async #listNow(namespace: Namespace): Promise<readonly RepositoryTarget[]> {
    const targets: RepositoryTarget[] = [];
    for (const entry of listCatalog(this.#database, namespace.namespaceId)) {
      targets.push(await this.#targets.resolve({ namespaceId: entry.namespace_id, repositoryId: entry.repository_id }));
    }
    return targets;
  }

  async #listSelectorsNow(namespace?: Namespace): Promise<readonly RepositorySelector[]> {
    return listRepositorySelectors(this.#database, namespace?.namespaceId);
  }

  async #availabilityNow(selector: RepositoryTargetSelector): Promise<RepositoryAvailability> {
    if (catalogEntry(this.#database, selector) === undefined) return { kind: "not-found" };
    if (hasPending(this.#database, selector)) return { kind: "recovery-required" };
    return { kind: "available", target: await this.#targets.resolve(selector) };
  }

  async #findFinalizedNow(query: ProtectedRefFinalizedQuery): Promise<ProtectedRefFinalized | undefined> {
    return this.#ports.journal.findFinalizedExact(parseProtectedRefFinalizedQuery(query));
  }

  close(): Promise<void> {
    return this.#admission.close(() => {
      try {
        this.#database.close();
      } finally {
        this.#owner.release();
      }
    });
  }
}
