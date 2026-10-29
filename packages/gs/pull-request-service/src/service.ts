import { randomUUID } from "node:crypto";
import type { DiscussionComment } from "@slop-lab/gs-discussions";
import {
  appendComment,
  appendRevision,
  assertVersion,
  currentRevision,
  markMerged,
  pullRequestSchema,
  PullRequestConflict,
  updatePullRequest,
  type PullRequest,
} from "@slop-lab/gs-pull-requests";
import { isCandidateRef, type RepositorySelector } from "@slop-lab/gs-repository-contracts";
import type {
  BorrowedRepositoryMutationAccess,
  RepositoryMutationGate,
  RepositoryReadGate,
  RepositoryReadService,
  RepositoryTarget,
} from "@slop-lab/gs-repository-service";
import type { ReviewRequest } from "@slop-lab/gs-review-contracts";
import { pinRevision, recordRefs, type OwnedPullRequestRef, type PullRequestRefWriter } from "./refs.js";
import { PullRequestStore } from "./store.js";

export interface RepositoryPrincipalScope {
  readonly principalId: string;
  authorize(target: RepositoryTarget): Promise<void>;
}

export interface OptionalReviewRequest {
  request(input: { readonly access: BorrowedRepositoryMutationAccess; readonly request: ReviewRequest }): Promise<unknown>;
}

export type PullRequestServiceOptions = {
  readonly stateDirectory: string;
  readonly readGate: RepositoryReadGate;
  readonly mutationGate: RepositoryMutationGate;
  readonly reader: RepositoryReadService;
  readonly refWriter: PullRequestRefWriter;
  readonly reviewRequest?: OptionalReviewRequest;
  readonly now?: () => string;
  readonly newId?: () => string;
};

export type CreatePullRequest = RepositorySelector & {
  readonly principal: RepositoryPrincipalScope;
  readonly title: string;
  readonly body?: string;
  readonly sourceRef: string;
  readonly targetRef?: string;
  readonly signal?: AbortSignal;
};

export class PullRequestService {
  readonly #options: PullRequestServiceOptions;
  readonly #store: PullRequestStore;

  constructor(options: PullRequestServiceOptions) {
    this.#options = options;
    this.#store = new PullRequestStore(options.stateDirectory);
  }

  create(input: CreatePullRequest): Promise<PullRequest> {
    return this.createWithOutcome(input).then(({ record }) => record);
  }

  createWithOutcome(input: CreatePullRequest): Promise<{ readonly record: PullRequest; readonly created: boolean }> {
    const selector = { namespaceId: input.namespaceId, repositoryId: input.repositoryId, ...(input.targetRef === undefined ? {} : { protectedRef: input.targetRef }) };
    return this.#options.mutationGate.mutate(selector, (access) => this.createInTransaction(access, input));
  }

  async createInTransaction(access: BorrowedRepositoryMutationAccess, input: CreatePullRequest): Promise<{ readonly record: PullRequest; readonly created: boolean }> {
    await input.principal.authorize(access.target);
    if (!isCandidateRef(input.sourceRef)) throw new PullRequestConflict("Invalid candidate ref");
    if (input.sourceRef === access.target.head.protectedRef) throw new PullRequestConflict("Source and target refs must differ");
    const records = await this.#store.list(input.namespaceId, input.repositoryId);
    const existing = records.find((entry) => entry.state === "open" && entry.sourceRef === input.sourceRef && entry.targetRef === access.target.head.protectedRef);
    const signal = input.signal ?? AbortSignal.timeout(30_000);
    const repositoryAccess = { principalId: input.principal.principalId, target: access.target };
    if (existing !== undefined) {
      if (existing.title !== input.title || existing.body !== (input.body ?? "")) {
        throw new PullRequestConflict(`An open pull request already exists: ${existing.id}`);
      }
      await pinRevision(this.#options.refWriter, repositoryAccess, existing, signal);
      await input.principal.authorize(access.target);
      await access.authority.assertCurrent(access.target);
      return { record: existing, created: false };
    }
    const refs = await this.snapshot(repositoryAccess, input.sourceRef);
    const now = this.now();
    const record = pullRequestSchema.parse({
      schemaVersion: 1,
      id: this.newId(),
      version: 1,
      title: input.title,
      body: input.body ?? "",
      sourceRef: input.sourceRef,
      targetRef: access.target.head.protectedRef,
      state: "open",
      actorId: input.principal.principalId,
      createdAt: now,
      updatedAt: now,
      revisions: [{ id: this.newId(), sourceCommit: refs.sourceCommit, targetCommit: refs.targetCommit, createdAt: now }],
      comments: [],
    });
    await this.#store.save(input.namespaceId, input.repositoryId, record);
    await pinRevision(this.#options.refWriter, repositoryAccess, record, signal);
    await input.principal.authorize(access.target);
    await access.authority.assertCurrent(access.target);
    return { record, created: true };
  }

  list(input: RepositorySelector & { readonly principal: RepositoryPrincipalScope }): Promise<readonly PullRequest[]> {
    return this.#options.readGate.read(input, async ({ authority, target }) => {
      await input.principal.authorize(target);
      const result = await this.#store.list(input.namespaceId, input.repositoryId);
      await input.principal.authorize(target);
      await authority.assertCurrent(target);
      return result;
    });
  }

  read(input: RepositorySelector & { readonly principal: RepositoryPrincipalScope; readonly requestId: string }): Promise<PullRequest | undefined> {
    return this.#options.readGate.read(input, async ({ authority, target }) => {
      await input.principal.authorize(target);
      const result = await this.#store.read(input.namespaceId, input.repositoryId, input.requestId);
      await input.principal.authorize(target);
      await authority.assertCurrent(target);
      return result;
    });
  }

  mutate(input: RepositorySelector & { readonly principal: RepositoryPrincipalScope; readonly requestId: string; readonly expectedVersion: number; readonly title?: string; readonly body?: string; readonly state?: "open" | "closed" }): Promise<PullRequest> {
    return this.#options.mutationGate.mutate(input, async (access) => {
      await input.principal.authorize(access.target);
      const record = await this.required(input);
      const changed = updatePullRequest(record, input.expectedVersion, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.state === undefined ? {} : { state: input.state }),
      }, this.now());
      await this.#store.save(input.namespaceId, input.repositoryId, changed);
      await input.principal.authorize(access.target);
      await access.authority.assertCurrent(access.target);
      return changed;
    });
  }

  refresh(input: RepositorySelector & { readonly principal: RepositoryPrincipalScope; readonly requestId: string; readonly expectedVersion: number; readonly signal?: AbortSignal }): Promise<PullRequest> {
    return this.#options.mutationGate.mutate(input, async (access) => {
      await input.principal.authorize(access.target);
      let record = await this.required(input);
      assertVersion(record, input.expectedVersion);
      if (record.state !== "open") return record;
      if (access.target.head.commit === currentRevision(record).sourceCommit) {
        record = markMerged(record, input.expectedVersion, this.now());
      } else {
        const refs = await this.snapshot({ principalId: input.principal.principalId, target: access.target }, record.sourceRef);
        record = appendRevision(record, input.expectedVersion, { id: this.newId(), sourceCommit: refs.sourceCommit, targetCommit: refs.targetCommit, createdAt: this.now() });
      }
      await this.#store.save(input.namespaceId, input.repositoryId, record);
      if (record.state === "open") await pinRevision(this.#options.refWriter, { principalId: input.principal.principalId, target: access.target }, record, input.signal ?? AbortSignal.timeout(30_000));
      await input.principal.authorize(access.target);
      await access.authority.assertCurrent(access.target);
      return record;
    });
  }

  async requestReview(input: RepositorySelector & { readonly principal: RepositoryPrincipalScope; readonly requestId: string; readonly expectedVersion: number }): Promise<unknown> {
    const reviewRequest = this.#options.reviewRequest;
    if (reviewRequest === undefined) throw new PullRequestReviewUnavailableError("pull request review is not configured");
    return this.#options.mutationGate.mutate(input, async (access) => {
      await input.principal.authorize(access.target);
      const record = await this.required(input);
      assertVersion(record, input.expectedVersion);
      if (record.state !== "open") throw new PullRequestConflict("Pull request is not open");
      const refs = await this.snapshot({ principalId: input.principal.principalId, target: access.target }, record.sourceRef);
      const revision = currentRevision(record);
      if (refs.sourceCommit !== revision.sourceCommit || refs.targetCommit !== revision.targetCommit) {
        throw new PullRequestConflict("Pull request revision is stale; refresh before reviewing");
      }
      const result = await reviewRequest.request({ access, request: {
        namespaceId: input.namespaceId,
        repositoryId: input.repositoryId,
        proposalRef: record.sourceRef,
        protectedRef: record.targetRef,
        requesterPrincipalId: input.principal.principalId,
      } });
      await this.assertProtectedHead({ principalId: input.principal.principalId, target: access.target });
      await input.principal.authorize(access.target);
      return { pullRequestId: record.id, revisionId: revision.id, review: result };
    });
  }

  async appendCommentInTransaction(access: BorrowedRepositoryMutationAccess, input: RepositorySelector & { readonly principal: RepositoryPrincipalScope; readonly requestId: string; readonly expectedVersion: number; readonly comment: DiscussionComment }): Promise<PullRequest> {
    await input.principal.authorize(access.target);
    const changed = appendComment(await this.required(input), input.expectedVersion, input.comment);
    await this.#store.save(input.namespaceId, input.repositoryId, changed);
    await input.principal.authorize(access.target);
    await access.authority.assertCurrent(access.target);
    return changed;
  }

  async readInTransaction(input: RepositorySelector & { readonly requestId: string }): Promise<PullRequest | undefined> {
    return this.#store.read(input.namespaceId, input.repositoryId, input.requestId);
  }

  async ownedRefs(selector: RepositorySelector): Promise<readonly OwnedPullRequestRef[]> {
    return (await this.#store.list(selector.namespaceId, selector.repositoryId)).flatMap(recordRefs);
  }

  repairPins(input: RepositorySelector & { readonly principal: RepositoryPrincipalScope; readonly signal?: AbortSignal }): Promise<void> {
    return this.#options.mutationGate.mutate(input, (access) => this.repairPinsInTransaction(access, input));
  }

  async repairPinsInTransaction(access: BorrowedRepositoryMutationAccess, input: RepositorySelector & { readonly principal: RepositoryPrincipalScope; readonly signal?: AbortSignal }): Promise<void> {
    await input.principal.authorize(access.target);
    const repositoryAccess = { principalId: input.principal.principalId, target: access.target };
    for (const record of await this.#store.list(input.namespaceId, input.repositoryId)) {
      for (const revision of record.revisions) {
        await pinRevision(this.#options.refWriter, repositoryAccess, record, input.signal ?? AbortSignal.timeout(30_000), revision);
      }
    }
  }

  private async required(input: RepositorySelector & { readonly requestId: string }): Promise<PullRequest> {
    const record = await this.#store.read(input.namespaceId, input.repositoryId, input.requestId);
    if (record === undefined) throw new PullRequestNotFoundError(input.requestId);
    return record;
  }

  private async snapshot(access: { readonly principalId: string; readonly target: RepositoryTarget }, sourceRef: string) {
    try {
      const sourceCommit = await this.#options.reader.readRef(access, sourceRef);
      await this.#options.reader.readCommitTree(access, sourceCommit);
      return { sourceCommit, targetCommit: access.target.head.commit };
    } catch (error) {
      if (error instanceof PullRequestConflict) throw error;
      throw new PullRequestConflict("Candidate snapshot is unavailable");
    }
  }

  private async assertProtectedHead(access: { readonly principalId: string; readonly target: RepositoryTarget }): Promise<void> {
    const current = await this.#options.reader.readRef(access, access.target.head.protectedRef);
    if (current !== access.target.head.commit) throw new PullRequestConflict("Target changed while resolving pull request");
  }

  private now(): string {
    return this.#options.now?.() ?? new Date().toISOString();
  }

  private newId(): string {
    return this.#options.newId?.() ?? randomUUID();
  }
}

export function openPullRequestService(options: PullRequestServiceOptions): PullRequestService {
  return new PullRequestService(options);
}

export class PullRequestNotFoundError extends Error {
  readonly name = "PullRequestNotFoundError";
  constructor(readonly requestId: string) {
    super("Pull request not found");
  }
}

export class PullRequestReviewUnavailableError extends Error {
  readonly name = "PullRequestReviewUnavailableError";
}
