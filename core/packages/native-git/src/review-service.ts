import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import type { NativeGitIdentity, NativeGitReviewPolicy, NativeGitServiceConfig } from "./config.js";
import { inspectGitReview, liveReviewObjects } from "./review-git.js";
import { refSerializationKey, type RefSerializer } from "./ref-serializer.js";
import {
  reviewDigest,
  reviewObjectSchema,
  type ChangedPath,
  type ReviewApproval,
  type ReviewIdentity,
  type ReviewObject
} from "./review-schema.js";
import { createReviewStore, ReviewOutboxFullError } from "./review-store.js";
import { createStatusStore } from "./status-store.js";
import type { CiStatusRecord } from "./promotion-schema.js";

export type ReviewStatus = Omit<ReviewObject, "requiredJobNames"> & {
  readonly status: "pending" | "approved" | "revoked" | "stale";
  readonly staleReasons: readonly string[];
  readonly approvals: readonly ReviewApproval[];
  readonly revocations: readonly { readonly approvalId: string; readonly revokedBy: string; readonly revokedAt: string }[];
  readonly statuses: readonly CiStatusRecord[];
};

type ReviewTarget = {
  readonly projectId: string;
  readonly repositoryId: string;
};

export type CreateReviewInput = ReviewTarget & {
  readonly protectedRef: string;
  readonly proposalRef: string;
};

export type ReviewService = {
  create(identity: NativeGitIdentity, input: CreateReviewInput): Promise<ReviewStatus>;
  get(identity: NativeGitIdentity, target: ReviewTarget, reviewId: string): Promise<ReviewStatus>;
  approve(identity: NativeGitIdentity, target: ReviewTarget, reviewId: string): Promise<ReviewApproval>;
  revoke(identity: NativeGitIdentity, target: ReviewTarget, reviewId: string, approvalId: string): Promise<void>;
};

export function createReviewService(
  config: NativeGitServiceConfig,
  serializer: RefSerializer,
  onOutboxChanged: () => void = () => undefined
): ReviewService {
  return {
    async create(identity, input) {
      authorizeInspection(identity, input);
      const policy = policyFor(config, input, input.protectedRef);
      const workspaceId = proposalWorkspace(input.proposalRef);
      const writer = config.identities.find((candidate) => candidate.role === "writer"
        && candidate.projectId === input.projectId && candidate.workspaceId === workspaceId
        && candidate.repositoryIds.includes(input.repositoryId));
      if (writer === undefined) throw new ReviewApiError(404, "proposal writer is not registered");
      const evidence = await inspectGitReview(config, input);
      const requiredReviewerIds = requiredReviewers(policy, evidence.changes);
      const reviewIdentity: ReviewIdentity = {
        schemaVersion: 1,
        ...input,
        ...evidence,
        policyRevision: policy.policyRevision,
        requiredReviewRevision: policy.requiredReviewRevision,
        requiredJobSetRevision: policy.requiredJobSetRevision,
        requiredJobNames: [...policy.requiredJobNames].sort(),
        policyDigest: policyDigest(policy),
        writerUsername: writer.username,
        workspaceId,
        requiredReviewerIds
      };
      const review = reviewObjectSchema.parse({
        ...reviewIdentity,
        reviewId: reviewDigest(reviewIdentity),
        createdAt: new Date().toISOString()
      });
      let stored: ReviewObject;
      try {
        stored = await serializer.run(`review-outbox:${input.projectId}/${input.repositoryId}`, () => (
          store(config, input).saveReview(review)
        ));
      } catch (error) {
        if (error instanceof ReviewOutboxFullError) throw new ReviewApiError(429, error.message);
        throw error;
      }
      onOutboxChanged();
      return status(config, stored);
    },
    async get(identity, target, reviewId) {
      authorizeInspection(identity, target);
      return status(config, await requiredReview(config, target, reviewId));
    },
    async approve(identity, target, reviewId) {
      authorizeInspection(identity, target);
      if (identity.role !== "reviewer") throw new ReviewApiError(403, "human reviewer authority is required");
      const review = await requiredReview(config, target, reviewId);
      if (!review.requiredReviewerIds.includes(identity.reviewerId)) throw new ReviewApiError(403, "reviewer is not required for this candidate");
      return serializer.run(refSerializationKey(review.projectId, review.repositoryId, review.protectedRef), async () => {
        const current = await status(config, review);
        if (current.status === "stale") throw new ReviewApiError(409, "review tuple is stale");
        const revoked = new Set(current.revocations.map((revocation) => revocation.approvalId));
        const existing = current.approvals.find((approval) => approval.reviewerId === identity.reviewerId && !revoked.has(approval.approvalId));
        if (existing !== undefined) return existing;
        return store(config, target).saveApproval({
          reviewId,
          reviewerId: identity.reviewerId,
          reviewerUsername: identity.username
        });
      });
    },
    async revoke(identity, target, reviewId, approvalId) {
      authorizeInspection(identity, target);
      const reviewStore = store(config, target);
      const review = await requiredReview(config, target, reviewId);
      const approval = (await reviewStore.readApprovals(reviewId)).find((candidate) => candidate.approvalId === approvalId);
      if (approval === undefined) throw new ReviewApiError(404, "approval was not found");
      if (identity.role !== "administrator" && (identity.role !== "reviewer" || identity.reviewerId !== approval.reviewerId)) {
        throw new ReviewApiError(403, "approval revocation authority is required");
      }
      await serializer.run(refSerializationKey(review.projectId, review.repositoryId, review.protectedRef), async () => {
        await reviewStore.saveRevocation({ approvalId, reviewId, revokedBy: identity.username });
      });
    }
  };
}

export async function status(config: NativeGitServiceConfig, review: ReviewObject): Promise<ReviewStatus> {
  const target = { projectId: review.projectId, repositoryId: review.repositoryId };
  const reviewStore = store(config, target);
  const [approvals, revocations, statuses, live] = await Promise.all([
    reviewStore.readApprovals(review.reviewId),
    reviewStore.readRevocations(review.reviewId),
    createStatusStore(join(config.storageRoot, review.projectId, `${review.repositoryId}.git`)).readStatuses(review.reviewId),
    liveReviewObjects(config, review)
  ]);
  const staleReasons: string[] = [];
  const currentPolicy = findPolicy(config, target, review.protectedRef);
  if (currentPolicy === undefined || policyDigest(currentPolicy) !== review.policyDigest
    || currentPolicy.policyRevision !== review.policyRevision
    || currentPolicy.requiredReviewRevision !== review.requiredReviewRevision
    || currentPolicy.requiredJobSetRevision !== review.requiredJobSetRevision) staleReasons.push("policy-changed");
  if (live.protectedHead !== review.expectedProtectedHead) staleReasons.push("protected-head-changed");
  if (live.candidateCommit !== review.candidateCommit) staleReasons.push("candidate-commit-changed");
  if (live.candidateTree !== review.candidateTree) staleReasons.push("candidate-tree-changed");
  const writer = config.identities.find((identity) => identity.role === "writer"
    && identity.projectId === review.projectId && identity.workspaceId === review.workspaceId
    && identity.repositoryIds.includes(review.repositoryId));
  if (writer?.username !== review.writerUsername) staleReasons.push("writer-identity-changed");
  const revoked = new Set(revocations.map((revocation) => revocation.approvalId));
  const currentApprovals = approvals.filter((approval) => {
    const reviewer = config.identities.find((identity) => identity.role === "reviewer" && identity.reviewerId === approval.reviewerId);
    return reviewer?.username === approval.reviewerUsername && reviewer.projectId === review.projectId
      && reviewer.repositoryIds.includes(review.repositoryId);
  });
  if (currentApprovals.length !== approvals.length) staleReasons.push("reviewer-identity-changed");
  const activeReviewers = new Set(currentApprovals.filter((approval) => !revoked.has(approval.approvalId)).map((approval) => approval.reviewerId));
  const complete = review.requiredReviewerIds.every((reviewerId) => activeReviewers.has(reviewerId));
  const reviewStatus = staleReasons.length > 0 ? "stale"
    : complete ? "approved"
      : revocations.length > 0 ? "revoked"
        : "pending";
  const { requiredJobNames: _requiredJobNames, ...publicReview } = review;
  return { ...publicReview, status: reviewStatus, staleReasons, approvals, revocations, statuses };
}

function requiredReviewers(policy: NativeGitReviewPolicy, changes: readonly ChangedPath[]): string[] {
  const reviewers = new Set(policy.requiredReviewerIds);
  for (const rule of policy.pathReviewerRules) {
    const prefix = Buffer.from(rule.pathPrefix, "utf8");
    const matches = changes.some((change) => [change.oldPathBytes, change.newPathBytes]
      .some((encoded) => encoded.length > 0 && Buffer.from(encoded, "base64").subarray(0, prefix.length).equals(prefix)));
    if (matches) for (const reviewerId of rule.reviewerIds) reviewers.add(reviewerId);
  }
  return [...reviewers].sort();
}

export function policyDigest(policy: NativeGitReviewPolicy): string {
  return createHash("sha256").update(JSON.stringify(policy), "utf8").digest("hex");
}

function proposalWorkspace(ref: string): string {
  const match = /^refs\/heads\/proposals\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/.+$/.exec(ref);
  const workspaceId = match?.[1];
  if (workspaceId === undefined) throw new ReviewApiError(400, "proposal ref is invalid");
  return workspaceId;
}

function policyFor(config: NativeGitServiceConfig, target: ReviewTarget, protectedRef: string): NativeGitReviewPolicy {
  const policy = findPolicy(config, target, protectedRef);
  if (policy === undefined) throw new ReviewApiError(404, "protected ref review policy was not found");
  return policy;
}

export function findPolicy(config: NativeGitServiceConfig, target: ReviewTarget, protectedRef: string): NativeGitReviewPolicy | undefined {
  return config.repositories.find((repository) => repository.projectId === target.projectId
    && repository.repositoryId === target.repositoryId)?.reviewPolicies?.find((policy) => policy.protectedRef === protectedRef);
}

export async function requiredReview(config: NativeGitServiceConfig, target: ReviewTarget, reviewId: string): Promise<ReviewObject> {
  const review = await store(config, target).readReview(reviewId);
  if (review === undefined || review.projectId !== target.projectId || review.repositoryId !== target.repositoryId) {
    throw new ReviewApiError(404, "review was not found");
  }
  return review;
}

function store(config: NativeGitServiceConfig, target: ReviewTarget) {
  return createReviewStore(join(config.storageRoot, target.projectId, `${target.repositoryId}.git`));
}

function authorizeInspection(identity: NativeGitIdentity, target: ReviewTarget): void {
  if (identity.projectId !== target.projectId || !identity.repositoryIds.includes(target.repositoryId)) {
    throw new ReviewApiError(404, "repository was not found");
  }
  if (identity.role !== "reviewer" && identity.role !== "administrator" && identity.role !== "promoter") {
    throw new ReviewApiError(403, "review authority is required");
  }
}

export class ReviewApiError extends Error {
  readonly name = "ReviewApiError";
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
