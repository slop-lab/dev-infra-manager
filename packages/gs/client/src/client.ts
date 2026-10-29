import { gitBlameRequestSchema, parseGitLineAttribution, type GitLineAttribution } from "@slop-lab/gs-blame";
import { parseDiffSnapshot, type DiffSnapshot } from "@slop-lab/gs-diff";
import { parsePullRequest, parsePullRequestList, type PullRequest } from "@slop-lab/gs-pull-requests";
import type { RepositorySelector } from "@slop-lab/gs-repository-contracts";
import { z } from "zod";
import {
  commentPullRequestInputSchema,
  createPullRequestInputSchema,
  diffInputSchema,
  mergePreparationInputSchema,
  pullRequestSelectionSchema,
  repositorySelectorSchema,
  resolveReviewInputSchema,
  reviewSelectionSchema,
  syncInputSchema,
  updatePullRequestInputSchema,
} from "./inputs.js";
import {
  gitCiStatusSchema,
  parseGitCiStatus,
  parseGitReview,
  preparedPullRequestReviewSchema,
  preparedMergeSchema,
  promotionSchema,
  reviewSummarySchema,
  syncResultSchema,
  type GitCiStatus,
  type GitReview,
  type PromotionReceipt,
  type PreparedPullRequestReview,
} from "./schemas.js";
import type { BoundedJsonTransport, GitClientCapability, GitServiceRequest, GitServiceRequestInput, PullRequestSelection } from "./transport.js";
import {
  approveSelectedPullRequest,
  mergeSelectedPullRequest,
  revokeSelectedPullRequest,
  type PullRequestWorkflowInput,
  type PullRequestWorkflowPort,
} from "./workflow.js";

const RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;
export type GitServiceClientOptions = {
  readonly transport: BoundedJsonTransport;
  readonly capabilities: readonly GitClientCapability[];
  readonly createRequestId?: () => string;
};

export function createGitServiceClient(options: GitServiceClientOptions): GitServiceClient {
  return new GitServiceClient(options);
}

export class GitServiceClient implements PullRequestWorkflowPort {
  readonly capabilities: readonly GitClientCapability[];
  private readonly selectedCapabilities: ReadonlySet<GitClientCapability>;
  private readonly createRequestId: () => string;

  constructor(private readonly options: GitServiceClientOptions) {
    this.selectedCapabilities = new Set(options.capabilities);
    this.capabilities = [...this.selectedCapabilities];
    this.createRequestId = options.createRequestId ?? (() => globalThis.crypto.randomUUID());
  }

  supports(capability: GitClientCapability): boolean {
    return this.selectedCapabilities.has(capability);
  }

  async readDiff(input: z.input<typeof diffInputSchema>): Promise<DiffSnapshot> {
    this.require("git-diff");
    const { namespaceId, repositoryId, baseCommit, headCommit } = diffInputSchema.parse(input);
    return parseDiffSnapshot(await this.send({ kind: "diff.read", selector: { namespaceId, repositoryId }, input: { baseCommit, headCommit } }));
  }

  async blameLine(input: RepositorySelector & z.input<typeof gitBlameRequestSchema>): Promise<GitLineAttribution> {
    this.require("git-blame");
    const row = z.record(z.string(), z.unknown()).parse(input);
    const { namespaceId, repositoryId, ...request } = row;
    const selector = repositorySelectorSchema.parse({ namespaceId, repositoryId });
    return parseGitLineAttribution(await this.send({ kind: "blame.line", selector, input: gitBlameRequestSchema.parse(request) }));
  }

  async readCiStatus(input: z.input<typeof reviewSelectionSchema>): Promise<GitCiStatus> {
    this.require("git-ci");
    const { namespaceId, repositoryId, reviewId } = reviewSelectionSchema.parse(input);
    return parseGitCiStatus(await this.send({ kind: "ci.status", selector: { namespaceId, repositoryId }, input: { reviewId } }));
  }

  async listPullRequests(selectorInput: RepositorySelector): Promise<readonly PullRequest[]> {
    this.require("git-pull-requests");
    const selector = repositorySelectorSchema.parse(selectorInput);
    return parsePullRequestList(await this.send({ kind: "pull-requests.list", selector, input: {} }));
  }

  async createPullRequest(input: z.input<typeof createPullRequestInputSchema>): Promise<PullRequest> {
    this.require("git-pull-requests");
    const { namespaceId, repositoryId, title, sourceRef, body: description, targetRef } = createPullRequestInputSchema.parse(input);
    const body = { title, sourceRef, ...(description === undefined ? {} : { body: description }), ...(targetRef === undefined ? {} : { targetRef }) };
    return parsePullRequest(await this.send({ kind: "pull-requests.create", selector: { namespaceId, repositoryId }, input: body }));
  }

  async updatePullRequest(input: z.input<typeof updatePullRequestInputSchema>): Promise<PullRequest> {
    this.require("git-pull-requests");
    const { namespaceId, repositoryId, pullRequestId, expectedVersion, title, body: description, state } = updatePullRequestInputSchema.parse(input);
    const body = { pullRequestId, expectedVersion, ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { body: description }), ...(state === undefined ? {} : { state }) };
    return parsePullRequest(await this.send({ kind: "pull-requests.update", selector: { namespaceId, repositoryId }, input: body }));
  }

  async commentPullRequest(input: z.input<typeof commentPullRequestInputSchema>): Promise<PullRequest> {
    this.require("git-pull-requests");
    this.require("git-discussions");
    this.require("git-diff");
    const { namespaceId, repositoryId, pullRequestId, expectedVersion, revisionId, body: text, anchor } = commentPullRequestInputSchema.parse(input);
    const body = { pullRequestId, expectedVersion, revisionId, body: text, ...(anchor === undefined ? {} : { anchor }) };
    return parsePullRequest(await this.send({ kind: "pull-requests.comment", selector: { namespaceId, repositoryId }, input: body }));
  }

  async listReviews(selectorInput: RepositorySelector): Promise<readonly z.infer<typeof reviewSummarySchema>[]> {
    this.require("git-review");
    const selector = repositorySelectorSchema.parse(selectorInput);
    return z.array(reviewSummarySchema).max(100).readonly().parse(await this.send({ kind: "reviews.list", selector, input: {} }));
  }

  async getReview(input: z.input<typeof reviewSelectionSchema>): Promise<GitReview> {
    this.require("git-review");
    const { namespaceId, repositoryId, reviewId } = reviewSelectionSchema.parse(input);
    return this.readReview({ namespaceId, repositoryId }, reviewId);
  }

  async resolveReview(input: z.input<typeof resolveReviewInputSchema>): Promise<GitReview> {
    this.require("git-review");
    const { namespaceId, repositoryId, proposalRef, protectedRef } = resolveReviewInputSchema.parse(input);
    const body = { proposalRef, ...(protectedRef === undefined ? {} : { protectedRef }) };
    const resolved = z.object({ review: z.object({ reviewId: z.string().regex(/^[a-f0-9]{64}$/) }) }).parse(
      await this.send({ kind: "reviews.resolve", selector: { namespaceId, repositoryId }, input: body }),
    );
    return this.readReview({ namespaceId, repositoryId }, resolved.review.reviewId);
  }

  async prepareMerge(input: z.input<typeof mergePreparationInputSchema>): Promise<z.infer<typeof preparedMergeSchema>> {
    this.require("git-merge");
    const { namespaceId, repositoryId, ...body } = mergePreparationInputSchema.parse(input);
    return preparedMergeSchema.parse(await this.send({ kind: "merges.prepare", selector: { namespaceId, repositoryId }, input: body }));
  }

  async promote(input: z.input<typeof reviewSelectionSchema>): Promise<PromotionReceipt> {
    const { namespaceId, repositoryId, reviewId } = reviewSelectionSchema.parse(input);
    return this.promoteReview({ namespaceId, repositoryId }, reviewId);
  }

  async sync(input: z.input<typeof syncInputSchema>): Promise<z.infer<typeof syncResultSchema>> {
    this.require("git-sync");
    const { namespaceId, repositoryId, action, protectedRef } = syncInputSchema.parse(input);
    const body = { action, ...(protectedRef === undefined ? {} : { protectedRef }) };
    return syncResultSchema.parse(await this.send({ kind: "sync", selector: { namespaceId, repositoryId }, input: body }));
  }

  async approvePullRequest(input: PullRequestWorkflowInput): Promise<GitReview> {
    this.require("git-pull-requests");
    this.require("git-review");
    return approveSelectedPullRequest(this, pullRequestSelectionSchema.parse(input));
  }

  async revokePullRequest(input: PullRequestWorkflowInput, reviewerId: string): Promise<GitReview> {
    this.require("git-pull-requests");
    this.require("git-review");
    return revokeSelectedPullRequest(this, pullRequestSelectionSchema.parse(input), reviewerId);
  }

  async mergePullRequest(input: PullRequestWorkflowInput): ReturnType<typeof mergeSelectedPullRequest> {
    this.require("git-pull-requests");
    this.require("git-review");
    this.require("git-merge");
    return mergeSelectedPullRequest(this, pullRequestSelectionSchema.parse(input));
  }

  async readPullRequest(selector: RepositorySelector, pullRequestId: string): Promise<PullRequest> {
    this.require("git-pull-requests");
    return parsePullRequest(await this.send({ kind: "pull-requests.detail", selector, input: { pullRequestId } }));
  }

  async preparePullRequestReview(selection: PullRequestSelection): Promise<PreparedPullRequestReview> {
    this.require("git-pull-requests");
    this.require("git-review");
    return preparedPullRequestReviewSchema.parse(await this.send({ kind: "pull-requests.review", selector: selection, input: {
      pullRequestId: selection.pullRequestId, expectedVersion: selection.expectedVersion,
    } }));
  }

  async readReview(selector: RepositorySelector, reviewId: string): Promise<GitReview> {
    this.require("git-review");
    const review = parseGitReview(await this.send({ kind: "reviews.detail", selector, input: { reviewId } }));
    if (!this.supports("git-ci")) return { ...review, ci: gitCiStatusSchema.parse({ schemaVersion: 1, reviewId,
      candidateCommit: review.candidateCommit, expectedProtectedHead: review.expectedProtectedHead, state: "not-configured", policy: "absent", requiredJobs: [] }) };
    let rawCi: unknown;
    try {
      rawCi = await this.send({ kind: "ci.status", selector, input: { reviewId } });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { ...review, ci: gitCiStatusSchema.parse({ schemaVersion: 1, reviewId, candidateCommit: review.candidateCommit,
        expectedProtectedHead: review.expectedProtectedHead, state: "unavailable", policy: "unknown", requiredJobs: [], reason: "inspection-unavailable" }) };
    }
    const ci = parseGitCiStatus(rawCi);
    if (ci.reviewId !== reviewId || ci.candidateCommit !== review.candidateCommit || ci.expectedProtectedHead !== review.expectedProtectedHead) {
      throw new GitClientResponseError("Git CI evidence does not match the selected review");
    }
    return { ...review, ci };
  }

  async approveReview(selector: RepositorySelector, reviewId: string): Promise<GitReview> {
    this.require("git-review");
    await this.send({ kind: "reviews.approve", selector, input: { reviewId, requestId: this.createRequestId() } });
    return this.readReview(selector, reviewId);
  }

  async revokeReview(selector: RepositorySelector, reviewId: string, approvalId: string): Promise<GitReview> {
    this.require("git-review");
    await this.send({ kind: "reviews.revoke", selector, input: { reviewId, approvalId } });
    return this.readReview(selector, reviewId);
  }

  async promoteReview(selector: RepositorySelector, reviewId: string): Promise<PromotionReceipt> {
    this.require("git-merge");
    return promotionSchema.parse(await this.send({ kind: "reviews.promote", selector, input: { reviewId } }));
  }

  async refreshPullRequest(selection: PullRequestSelection): Promise<PullRequest> {
    this.require("git-pull-requests");
    return parsePullRequest(await this.send({ kind: "pull-requests.refresh", selector: selection,
      input: { pullRequestId: selection.pullRequestId, expectedVersion: selection.expectedVersion } }));
  }

  private require(capability: GitClientCapability): void {
    if (!this.supports(capability)) throw new GitClientCapabilityError(capability);
  }

  private send(request: GitServiceRequestInput): Promise<unknown> {
    const bounded: GitServiceRequest = { ...request, responseLimitBytes: RESPONSE_LIMIT_BYTES };
    return this.options.transport.request(bounded);
  }
}

export class GitClientCapabilityError extends Error {
  readonly name = "GitClientCapabilityError";
  constructor(readonly capability: GitClientCapability) {
    super(`Git capability '${capability}' is unavailable`);
  }
}

export class GitClientResponseError extends Error {
  readonly name = "GitClientResponseError";
}
