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
  BorrowedRepositoryReadAuthority,
  RepositoryTarget,
} from "@slop-lab/gs-repository-service";
import { pinRevision, recordRefs, type OwnedPullRequestRef } from "./refs.js";
import { assertMatchingReview, type PullRequestReviewResult } from "./review-result.js";
import { PullRequestStore } from "./store.js";
import type { CreatePullRequest, PullRequestServiceOptions, RepositoryPrincipalScope } from "./types.js";

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
      for (const protectedRef of new Set(result.map((record) => record.targetRef))) {
        const recordTarget = await resolveRecordTarget(authority, input, protectedRef);
        await input.principal.authorize(recordTarget);
        await authority.assertCurrent(recordTarget);
      }
      return result;
    });
  }

  read(input: RepositorySelector & { readonly principal: RepositoryPrincipalScope; readonly requestId: string }): Promise<PullRequest | undefined> {
    return this.#options.readGate.read(input, async ({ authority, target }) => {
      await input.principal.authorize(target);
      const result = await this.#store.read(input.namespaceId, input.repositoryId, input.requestId);
      const recordTarget = result === undefined ? target : await resolveRecordTarget(authority, input, result.targetRef);
      await input.principal.authorize(recordTarget);
      await authority.assertCurrent(recordTarget);
      return result;
    });
  }

  mutate(input: RepositorySelector & { readonly principal: RepositoryPrincipalScope; readonly requestId: string; readonly expectedVersion: number; readonly title?: string; readonly body?: string; readonly state?: "open" | "closed" }): Promise<PullRequest> {
    return this.#options.mutationGate.mutate(input, async (access) => {
      await input.principal.authorize(access.target);
      const record = await this.required(input);
      const target = await resolveRecordTarget(access.authority, input, record.targetRef);
      await input.principal.authorize(target);
      const changed = updatePullRequest(record, input.expectedVersion, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.state === undefined ? {} : { state: input.state }),
      }, this.now());
      await this.#store.save(input.namespaceId, input.repositoryId, changed);
      await input.principal.authorize(target);
      await access.authority.assertCurrent(target);
      return changed;
    });
  }

  refresh(input: RepositorySelector & { readonly principal: RepositoryPrincipalScope; readonly requestId: string; readonly expectedVersion: number; readonly signal?: AbortSignal }): Promise<PullRequest> {
    return this.#options.mutationGate.mutate(input, async (access) => {
      let record = await this.required(input);
      const target = await resolveRecordTarget(access.authority, input, record.targetRef);
      await input.principal.authorize(target);
      assertVersion(record, input.expectedVersion);
      if (record.state !== "open") return record;
      if (target.head.commit === currentRevision(record).sourceCommit) {
        record = markMerged(record, input.expectedVersion, this.now());
      } else {
        const refs = await this.snapshot({ principalId: input.principal.principalId, target }, record.sourceRef);
        record = appendRevision(record, input.expectedVersion, { id: this.newId(), sourceCommit: refs.sourceCommit, targetCommit: refs.targetCommit, createdAt: this.now() });
      }
      await this.#store.save(input.namespaceId, input.repositoryId, record);
      if (record.state === "open") await pinRevision(this.#options.refWriter, { principalId: input.principal.principalId, target }, record, input.signal ?? AbortSignal.timeout(30_000));
      await input.principal.authorize(target);
      await access.authority.assertCurrent(target);
      return record;
    });
  }

  async requestReview(input: RepositorySelector & { readonly principal: RepositoryPrincipalScope; readonly requestId: string; readonly expectedVersion: number }): Promise<PullRequestReviewResult> {
    const reviewRequest = this.#options.reviewRequest;
    if (reviewRequest === undefined) throw new PullRequestReviewUnavailableError("pull request review is not configured");
    return this.#options.mutationGate.mutate(input, async (access) => {
      const record = await this.required(input);
      const target = await resolveRecordTarget(access.authority, input, record.targetRef);
      const exactAccess = { authority: access.authority, target };
      await input.principal.authorize(target);
      assertVersion(record, input.expectedVersion);
      if (record.state !== "open") throw new PullRequestConflict("Pull request is not open");
      const repositoryAccess = { principalId: input.principal.principalId, target };
      const refs = await this.snapshot(repositoryAccess, record.sourceRef);
      const revision = currentRevision(record);
      if (refs.sourceCommit !== revision.sourceCommit || refs.targetCommit !== revision.targetCommit) {
        throw new PullRequestConflict("Pull request revision is stale; refresh before reviewing");
      }
      const sourceTree = await this.#options.reader.readCommitTree(repositoryAccess, revision.sourceCommit);
      const result = await reviewRequest.request({ access: exactAccess, request: {
        namespaceId: input.namespaceId,
        repositoryId: input.repositoryId,
        proposalRef: record.sourceRef,
        protectedRef: record.targetRef,
        requesterPrincipalId: input.principal.principalId,
      } });
      assertMatchingReview(result, { namespaceId: input.namespaceId, repositoryId: input.repositoryId,
        proposalRef: record.sourceRef, protectedRef: record.targetRef, sourceCommit: revision.sourceCommit,
        sourceTree, targetCommit: revision.targetCommit });
      const current = await this.snapshot(repositoryAccess, record.sourceRef);
      if (current.sourceCommit !== revision.sourceCommit || current.targetCommit !== revision.targetCommit) {
        throw new PullRequestConflict("Pull request revision became stale during review");
      }
      await input.principal.authorize(target);
      return { pullRequestId: record.id, revisionId: revision.id, review: result };
    });
  }

  async appendCommentInTransaction(access: BorrowedRepositoryMutationAccess, input: RepositorySelector & { readonly principal: RepositoryPrincipalScope; readonly requestId: string; readonly expectedVersion: number; readonly comment: DiscussionComment }): Promise<PullRequest> {
    const record = await this.required(input);
    const target = await resolveRecordTarget(access.authority, input, record.targetRef);
    await input.principal.authorize(target);
    const changed = appendComment(record, input.expectedVersion, input.comment);
    await this.#store.save(input.namespaceId, input.repositoryId, changed);
    await input.principal.authorize(target);
    await access.authority.assertCurrent(target);
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

  private now(): string {
    return this.#options.now?.() ?? new Date().toISOString();
  }

  private newId(): string {
    return this.#options.newId?.() ?? randomUUID();
  }
}

function resolveRecordTarget(
  authority: BorrowedRepositoryReadAuthority,
  selector: RepositorySelector,
  protectedRef: string,
): Promise<RepositoryTarget> {
  return authority.resolve({ namespaceId: selector.namespaceId, repositoryId: selector.repositoryId, protectedRef });
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
