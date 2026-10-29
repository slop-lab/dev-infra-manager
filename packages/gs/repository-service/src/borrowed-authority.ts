import type { ProtectedRefChange, ProtectedRefFinalized, ProtectedRefFinalizedQuery, ProtectedRefReceipt } from "@slop-lab/gs-repository";
import type { Namespace, RepositorySelector } from "@slop-lab/gs-repository-contracts";
import type {
  BorrowedRepositoryMutationAuthority,
  BorrowedRepositoryReadAuthority,
  RepositoryAvailability,
  RepositoryTarget,
  RepositoryTargetSelector,
} from "./ports.js";
import { RepositoryStateError } from "./state.js";

export type BorrowedReadOperations = {
  readonly authorityEpoch: string;
  readonly resolve: (selector: RepositoryTargetSelector) => Promise<RepositoryTarget>;
  readonly assertCurrent: (target: RepositoryTarget) => Promise<void>;
  readonly list: (namespace: Namespace) => Promise<readonly RepositoryTarget[]>;
  readonly listSelectors: (namespace?: Namespace) => Promise<readonly RepositorySelector[]>;
  readonly availability: (selector: RepositoryTargetSelector) => Promise<RepositoryAvailability>;
  readonly findFinalized: (query: ProtectedRefFinalizedQuery) => Promise<ProtectedRefFinalized | undefined>;
};

export type BorrowedMutationOperations = BorrowedReadOperations & {
  readonly promote: (change: ProtectedRefChange) => Promise<ProtectedRefReceipt>;
};

export class BorrowedRepositoryReadAuthorityHandle implements BorrowedRepositoryReadAuthority {
  readonly authorityEpoch: string;
  readonly #operations: BorrowedReadOperations;
  readonly #pending = new Set<Promise<unknown>>();
  #active = true;

  constructor(operations: BorrowedReadOperations) {
    this.#operations = operations;
    this.authorityEpoch = operations.authorityEpoch;
  }

  resolve(selector: RepositoryTargetSelector): Promise<RepositoryTarget> {
    return this.track(() => this.#operations.resolve(selector));
  }

  assertCurrent(target: RepositoryTarget): Promise<void> {
    return this.track(() => this.#operations.assertCurrent(target));
  }

  list(namespace: Namespace): Promise<readonly RepositoryTarget[]> {
    return this.track(() => this.#operations.list(namespace));
  }

  listSelectors(namespace?: Namespace): Promise<readonly RepositorySelector[]> {
    return this.track(() => this.#operations.listSelectors(namespace));
  }

  availability(selector: RepositoryTargetSelector): Promise<RepositoryAvailability> {
    return this.track(() => this.#operations.availability(selector));
  }

  findFinalized(query: ProtectedRefFinalizedQuery): Promise<ProtectedRefFinalized | undefined> {
    return this.track(() => this.#operations.findFinalized(query));
  }

  async drainAndRevoke(): Promise<void> {
    this.#active = false;
    while (this.#pending.size > 0) await Promise.allSettled(this.#pending);
  }

  protected track<Result>(start: () => Promise<Result>): Promise<Result> {
    if (!this.#active) return Promise.reject(new RepositoryStateError("borrowed repository authority expired"));
    const operation = start();
    this.#pending.add(operation);
    void operation.then(
      () => this.#pending.delete(operation),
      () => this.#pending.delete(operation),
    );
    return operation;
  }
}

export class BorrowedRepositoryMutationAuthorityHandle
  extends BorrowedRepositoryReadAuthorityHandle implements BorrowedRepositoryMutationAuthority {
  readonly #promote: BorrowedMutationOperations["promote"];

  constructor(operations: BorrowedMutationOperations) {
    super(operations);
    this.#promote = operations.promote;
  }

  promote(change: ProtectedRefChange): Promise<ProtectedRefReceipt> {
    return this.track(() => this.#promote(change));
  }
}
