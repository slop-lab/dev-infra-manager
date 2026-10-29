import { execFile } from "node:child_process";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import {
  assertGitExecutableIdentity,
  assertRegisteredRepository,
  type GitExecutableIdentity,
  type GitRepositoryRuntime,
  type ProtectedRefIntent,
  type ProtectedRefTarget,
} from "@slop-lab/gs-repository";
import type { RepositorySelector } from "@slop-lab/gs-repository-contracts";
import { catalogEntry, effectivePolicy } from "./catalog.js";
import { immutableRepositoryPolicy, repositoryPolicyDigest } from "./model.js";
import type { RepositoryTarget, RepositoryTargetSelector } from "./ports.js";
import { RepositoryStateError } from "./state.js";
import { currentHead } from "./state-validation.js";

const execute = promisify(execFile);

export class RepositoryTargetOwner {
  readonly #runtime: GitRepositoryRuntime;
  readonly #gitIdentity: GitExecutableIdentity;
  readonly #database: DatabaseSync;
  readonly #epoch: string;
  readonly #expectedRefPolicyRevision: string;
  readonly #currentRefPolicyRevision: () => string;

  constructor(options: {
    readonly runtime: GitRepositoryRuntime;
    readonly gitIdentity: GitExecutableIdentity;
    readonly database: DatabaseSync;
    readonly epoch: string;
    readonly expectedRefPolicyRevision: string;
    readonly currentRefPolicyRevision: () => string;
  }) {
    this.#runtime = options.runtime;
    this.#gitIdentity = options.gitIdentity;
    this.#database = options.database;
    this.#epoch = options.epoch;
    this.#expectedRefPolicyRevision = options.expectedRefPolicyRevision;
    this.#currentRefPolicyRevision = options.currentRefPolicyRevision;
  }

  async resolve(selector: RepositoryTargetSelector): Promise<RepositoryTarget> {
    const catalog = catalogEntry(this.#database, selector);
    if (catalog === undefined) throw new RepositoryStateError("repository is not registered");
    this.#assertRefPolicyRevision();
    const policy = effectivePolicy(this.#database, selector);
    const head = currentHead(this.#database, selector);
    if (policy.policyDigest !== head.policyDigest) throw new RepositoryStateError("repository policy snapshot conflicts with current head");
    const target = {
      selector: { namespaceId: selector.namespaceId, repositoryId: selector.repositoryId },
      repositoryPath: this.repositoryPath(selector),
      head: { sequence: head.sequence, protectedRef: head.protectedRef, commit: head.commit, tree: head.tree },
      incarnationId: catalog.incarnation_id,
      authorityEpoch: this.#epoch,
      policyDigest: head.policyDigest,
      ownerPrincipalId: catalog.owner_principal_id,
      refPolicyRevision: this.#expectedRefPolicyRevision,
      policy: immutableRepositoryPolicy(policy.policy),
    };
    await assertRegisteredRepository(this.#runtime, target.selector);
    await this.assertGitHead(target.selector, head.protectedRef, head.commit, head.tree);
    return target;
  }

  async resolveCore(selector: RepositoryTargetSelector): Promise<ProtectedRefTarget> {
    const target = await this.resolve(selector);
    return {
      selector: target.selector,
      repositoryPath: target.repositoryPath,
      head: target.head,
      incarnationId: target.incarnationId,
      authorityEpoch: target.authorityEpoch,
      policyDigest: target.policyDigest,
      ownerPrincipalId: target.ownerPrincipalId,
      refPolicyRevision: target.refPolicyRevision,
    };
  }

  async assertCurrent(target: ProtectedRefTarget | RepositoryTarget): Promise<void> {
    const current = await this.resolve({ ...target.selector, protectedRef: target.head.protectedRef });
    if (target.repositoryPath !== current.repositoryPath || target.incarnationId !== current.incarnationId) {
      throw new RepositoryStateError("repository incarnation changed");
    }
    if (target.authorityEpoch !== current.authorityEpoch) throw new RepositoryStateError("repository authority epoch changed");
    if (target.policyDigest !== current.policyDigest) throw new RepositoryStateError("repository policy changed");
    if (target.ownerPrincipalId !== current.ownerPrincipalId) throw new RepositoryStateError("repository owner changed");
    if (target.refPolicyRevision !== current.refPolicyRevision) throw new RepositoryStateError("repository ref-update policy changed");
    if ("policy" in target && (repositoryPolicyDigest(target.policy) !== target.policyDigest
      || JSON.stringify(target.policy) !== JSON.stringify(current.policy))) {
      throw new RepositoryStateError("repository policy snapshot changed");
    }
    if (target.head.sequence !== current.head.sequence || target.head.commit !== current.head.commit || target.head.tree !== current.head.tree) {
      throw new RepositoryStateError("repository protected head changed");
    }
  }

  async locateForRecovery(intent: ProtectedRefIntent): Promise<string> {
    const catalog = catalogEntry(this.#database, intent);
    const policy = effectivePolicy(this.#database, intent);
    if (catalog === undefined || catalog.incarnation_id !== intent.incarnationId
      || catalog.owner_principal_id !== intent.ownerPrincipalId || policy.policyDigest !== intent.policyDigest) {
      throw new RepositoryStateError("pending repository transition authority is stale");
    }
    await assertRegisteredRepository(this.#runtime, intent);
    return this.repositoryPath(intent);
  }

  async assertGitHead(selector: RepositorySelector, ref: string, commit: string, tree: string): Promise<void> {
    await assertGitExecutableIdentity(this.#runtime.gitExecutable, this.#gitIdentity);
    const repositoryPath = this.repositoryPath(selector);
    const actualCommit = await this.git(repositoryPath, ref);
    const actualTree = await this.git(repositoryPath, `${commit}^{tree}`);
    if (actualCommit !== commit || actualTree !== tree) throw new RepositoryStateError("repository Git head conflicts with durable authority");
  }

  private repositoryPath(selector: RepositorySelector): string {
    return join(this.#runtime.storageRoot, selector.namespaceId, `${selector.repositoryId}.git`);
  }

  private async git(repositoryPath: string, expression: string): Promise<string> {
    const result = await execute(this.#runtime.gitExecutable, ["--no-replace-objects", "--git-dir", repositoryPath, "rev-parse", "--verify", expression], {
      env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", HOME: "/dev/null", LC_ALL: "C" },
      maxBuffer: 1024,
      timeout: 30_000,
    });
    return result.stdout.trim();
  }

  #assertRefPolicyRevision(): void {
    if (this.#currentRefPolicyRevision() !== this.#expectedRefPolicyRevision) {
      throw new RepositoryStateError("selected ref-update policies changed during authority lifetime");
    }
  }
}
