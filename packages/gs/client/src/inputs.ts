import { discussionAnchorSchema } from "@slop-lab/gs-discussions";
import { isCandidateRef, isOrdinaryCandidateRef } from "@slop-lab/gs-repository-contracts";
import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const opaqueId = z.string().min(1).max(256).refine((value) => !value.includes("\0"));
const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const candidateRef = z.string().max(1024).refine(isCandidateRef);
const ordinaryBranch = z.string().max(1024).refine((ref) => ref.startsWith("refs/heads/") && isOrdinaryCandidateRef(ref));

export const repositorySelectorSchema = z.object({ namespaceId: identifier, repositoryId: identifier }).strict();
export const diffInputSchema = repositorySelectorSchema.extend({ baseCommit: objectId, headCommit: objectId }).strict().readonly();
export const reviewSelectionSchema = repositorySelectorSchema.extend({ reviewId: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly();
export const pullRequestSelectionSchema = repositorySelectorSchema.extend({
  pullRequestId: opaqueId,
  expectedVersion: z.number().int().positive(),
  revisionId: opaqueId,
}).strict().readonly();
export const createPullRequestInputSchema = repositorySelectorSchema.extend({
  title: z.string().trim().min(1).max(240),
  body: z.string().max(3000).optional(),
  sourceRef: candidateRef,
  targetRef: ordinaryBranch.optional(),
}).strict().readonly();
export const updatePullRequestInputSchema = repositorySelectorSchema.extend({
  pullRequestId: opaqueId,
  expectedVersion: z.number().int().positive(),
  title: z.string().trim().min(1).max(240).optional(),
  body: z.string().max(3000).optional(),
  state: z.enum(["open", "closed"]).optional(),
}).strict().readonly();
export const commentPullRequestInputSchema = repositorySelectorSchema.extend({
  pullRequestId: opaqueId,
  expectedVersion: z.number().int().positive(),
  revisionId: opaqueId,
  body: z.string().trim().min(1).max(3000),
  anchor: discussionAnchorSchema.optional(),
}).strict().readonly();
export const resolveReviewInputSchema = repositorySelectorSchema.extend({
  proposalRef: candidateRef,
  protectedRef: ordinaryBranch.optional(),
}).strict().readonly();
export const mergePreparationInputSchema = repositorySelectorSchema.extend({
  sourceRef: ordinaryBranch,
  targetRef: ordinaryBranch,
}).strict().readonly();
export const syncInputSchema = repositorySelectorSchema.extend({
  action: z.enum(["fetch", "merge", "publish"]),
  protectedRef: ordinaryBranch.optional(),
}).strict().readonly();
