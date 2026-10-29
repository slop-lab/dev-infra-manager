import type { DatabaseSync } from "node:sqlite";
import { repositoryBranches } from "@slop-lab/gs-repository-contracts";
import { appendPolicyUpdate, catalogEntry, effectivePolicy, insertRegistration, readBaselines } from "./catalog.js";
import type { RepositoryStateIntegrityBoundary } from "./integrity-boundary.js";
import { registerRepositorySchema, replacePolicySchema, type RegisterRepositoryInput, type ReplaceRepositoryPolicyInput } from "./model.js";
import { assertPolicyCapabilities } from "./policy-capabilities.js";
import type { PolicySectionOwner, RefUpdatePolicy, RepositoryTarget } from "./ports.js";
import { RepositoryStateError, transaction } from "./state.js";
import { currentHead, hasPending } from "./state-validation.js";
import type { RepositoryTargetOwner } from "./target-owner.js";

export class RepositoryCatalogOwner {
  readonly #database: DatabaseSync;
  readonly #integrity: RepositoryStateIntegrityBoundary;
  readonly #targets: RepositoryTargetOwner;
  readonly #providers: readonly RefUpdatePolicy[];
  readonly #sectionOwners: readonly PolicySectionOwner[];

  constructor(options: {
    readonly database: DatabaseSync;
    readonly integrity: RepositoryStateIntegrityBoundary;
    readonly targets: RepositoryTargetOwner;
    readonly providers: readonly RefUpdatePolicy[];
    readonly sectionOwners: readonly PolicySectionOwner[];
  }) {
    this.#database = options.database;
    this.#integrity = options.integrity;
    this.#targets = options.targets;
    this.#providers = options.providers;
    this.#sectionOwners = options.sectionOwners;
  }

  async register(input: RegisterRepositoryInput): Promise<RepositoryTarget> {
    const registration = registerRepositorySchema.parse(input);
    assertPolicyCapabilities(registration.policy, this.#sectionOwners, this.#providers);
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
    this.#integrity.assertUnchanged();
    transaction(this.#database, () => insertRegistration(this.#database, registration));
    return this.#targets.resolve(registration.selector);
  }

  async replacePolicy(input: ReplaceRepositoryPolicyInput): Promise<RepositoryTarget> {
    const replacement = replacePolicySchema.parse(input);
    assertPolicyCapabilities(replacement.policy, this.#sectionOwners, this.#providers);
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
    this.#integrity.assertUnchanged();
    transaction(this.#database, () => appendPolicyUpdate(this.#database, {
      selector: replacement.selector,
      headSequence: head.sequence,
      headCommit: head.commit,
      previousPolicyDigest: current.policyDigest,
      policy: replacement.policy,
    }));
    return this.#targets.resolve(replacement.selector);
  }
}
