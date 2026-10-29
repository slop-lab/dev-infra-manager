import type { DatabaseSync } from "node:sqlite";
import { assertGitExecutableIdentity, compareAndSwapProtectedRef, parseProtectedRefFinalizedQuery, recoverProtectedRefChanges, type GitExecutableIdentity, type GitRepositoryRuntime, type ProtectedRefChange, type ProtectedRefFinalized, type ProtectedRefFinalizedQuery, type ProtectedRefPorts, type ProtectedRefReceipt } from "@slop-lab/gs-repository";
import { type Namespace, type RepositorySelector } from "@slop-lab/gs-repository-contracts";
import { RepositoryAdmission } from "./admission.js";
import { catalogEntry, effectivePolicy, listCatalog, listRepositorySelectors } from "./catalog.js";
import { RepositoryCatalogOwner } from "./catalog-owner.js";
import { BorrowedRepositoryMutationAuthorityHandle, BorrowedRepositoryReadAuthorityHandle, type BorrowedReadOperations } from "./borrowed-authority.js";
import { createJournalPort } from "./journal.js";
import { RepositoryStateIntegrityBoundary } from "./integrity-boundary.js";
import { newAuthorityEpoch, type RegisterRepositoryInput, type ReplaceRepositoryPolicyInput } from "./model.js";
import { acquireStateOwner, type StateOwner } from "./owner.js";
import { assertStoredPolicyCapabilities } from "./policy-capabilities.js";
import { authorizeRefUpdatePolicies, selectedRefUpdatePolicyRevision } from "./ref-update-policy.js";
import type { RefUpdatePolicy, BorrowedRepositoryMutationAccess, BorrowedRepositoryMutationAuthority, BorrowedRepositoryReadAccess, PolicySectionOwner, RepositoryAuthority, RepositoryAvailability, RepositoryExclusiveGate, RepositoryMutationGate, RepositoryReadGate, RepositoryTarget, RepositoryTargetSelector } from "./ports.js";
import { initializeAuthorityEpoch, openStateDatabase, RepositoryStateError } from "./state.js";
import { assertDurableState, hasPending } from "./state-validation.js";
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
    const integrity = new RepositoryStateIntegrityBoundary(database);
    assertDurableState(database);
    assertStoredPolicyCapabilities(database, options.policySectionOwners ?? [], options.refUpdatePolicies);
    const epoch = newAuthorityEpoch();
    initializeAuthorityEpoch(database, epoch, refPolicyRevision);
    integrity.assertUnchanged();
    const authority = new DurableRepositoryAuthority(options, { owner, database, epoch, refPolicyRevision, integrity });
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
  readonly #catalogOwner: RepositoryCatalogOwner;
  readonly #admission = new RepositoryAdmission();
  readonly #integrity: RepositoryStateIntegrityBoundary;

  constructor(options: RepositoryAuthorityOptions, resources: {
    readonly owner: StateOwner;
    readonly database: DatabaseSync;
    readonly epoch: string;
    readonly refPolicyRevision: string;
    readonly integrity: RepositoryStateIntegrityBoundary;
  }) {
    this.#owner = resources.owner;
    this.#database = resources.database;
    this.authorityEpoch = resources.epoch;
    this.#integrity = resources.integrity;
    this.#targets = new RepositoryTargetOwner({
      runtime: options.runtime,
      gitIdentity: options.gitIdentity,
      database: resources.database,
      epoch: resources.epoch,
      expectedRefPolicyRevision: resources.refPolicyRevision,
      currentRefPolicyRevision: () => selectedRefUpdatePolicyRevision(options.refUpdatePolicies),
      integrity: resources.integrity,
    });
    this.#catalogOwner = new RepositoryCatalogOwner({ database: resources.database, integrity: resources.integrity,
      targets: this.#targets, providers: options.refUpdatePolicies, sectionOwners: options.policySectionOwners ?? [] });
    const ports: Omit<ProtectedRefPorts, "serialization"> = {
      runtime: options.runtime,
      gitIdentity: options.gitIdentity,
      journal: createJournalPort(resources.database, resources.integrity),
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
    return this.#withExclusive(() => this.#catalogOwner.register(input));
  }

  async replacePolicy(input: ReplaceRepositoryPolicyInput): Promise<RepositoryTarget> {
    return this.#withExclusive(() => this.#catalogOwner.replacePolicy(input));
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
    return this.#admission.runExclusive(async () => {
      this.#integrity.assertUnchanged();
      const result = await operation();
      this.#integrity.assertUnchanged();
      return result;
    });
  }

  #withRead<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.#admission.runRead(async () => {
      this.#integrity.assertUnchanged();
      const result = await operation();
      this.#integrity.assertUnchanged();
      return result;
    });
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
