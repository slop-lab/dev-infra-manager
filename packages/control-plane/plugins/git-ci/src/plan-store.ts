import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { readAuthoritativeNativeReviewEnvelope as readReview, readAuthoritativeNativeReviewEnvelopes as readReviews,
  assertAuthoritativeNativeReviewStore as assertReviewStore, type AuthoritativeNativeReviewEnvelope as ReviewEnvelope,
  type ReviewAttachment } from "@slop-lab/dim-control-plane-plugin-code-review/extensions";
import { ownedReviewDirectory, writeImmutableReviewRecord, readReviewJson } from "@slop-lab/dim-control-plane-plugin-code-review/extensions";
import { gitCiPlanningSchema, authoritativeNativeRequiredJobSchema, createAuthoritativeNativeReviewEnvelope,
  type AuthoritativeNativeReviewEnvelope } from "./plan-schema.js";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const gitCiPlanSchema = z.object({ schemaVersion: z.literal(1),
  projectId: z.string(), repositoryId: z.string(), expectedProtectedHead: objectId,
  candidateCommit: objectId, candidateTree: objectId, policyDigest: digest, qualityRevision: digest,
  requiredJobs: z.array(authoritativeNativeRequiredJobSchema).max(64).readonly(), planning: gitCiPlanningSchema
}).strict().readonly();
export type GitCiPlan = z.infer<typeof gitCiPlanSchema>;
function planDigest(plan: GitCiPlan): string {
  return createHash("sha256").update("dim-git-ci-plan-v1\0").update(JSON.stringify(plan)).digest("hex");
}
export async function saveGitCiPlan(repository: string, input: GitCiPlan): Promise<ReviewAttachment> {
  const plan = gitCiPlanSchema.parse(input), digest = planDigest(plan);
  if (Buffer.byteLength(JSON.stringify(plan)) > 8 * 1024 * 1024) throw new Error("Git CI plan exceeds its storage bound");
  const root = join(repository, "dim-git-ci-plans"); await ownedReviewDirectory(root);
  const path = join(root, `${digest}.json`);
  try { await writeImmutableReviewRecord(path, plan); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const previous = gitCiPlanSchema.parse(await readReviewJson(path, 8 * 1024 * 1024, true));
    if (planDigest(previous) !== digest) throw new Error("Git CI plan storage conflicts");
  }
  return { kind: "git-ci", id: digest, digest };
}
export async function gitCiEnvelope(repository: string, envelope: ReviewEnvelope): Promise<AuthoritativeNativeReviewEnvelope | undefined> {
  const attachments = envelope.attachments.filter(({ kind }) => kind === "git-ci");
  if (!attachments.length) return;
  if (attachments.length !== 1) throw new Error("review has conflicting Git CI attachments");
  const attachment = attachments[0]!;
  if (!/^[0-9a-f]{64}$/.test(attachment.id) || attachment.digest !== attachment.id) throw new Error("Git CI attachment identity is invalid");
  const plan = gitCiPlanSchema.parse(await readReviewJson(join(repository, "dim-git-ci-plans", `${attachment.id}.json`), 8 * 1024 * 1024, true));
  const review = envelope.review;
  if (planDigest(plan) !== attachment.digest || plan.policyDigest !== envelope.policyDigest || plan.projectId !== review.projectId
    || plan.repositoryId !== review.repositoryId || plan.expectedProtectedHead !== review.expectedProtectedHead
    || plan.candidateCommit !== review.candidateCommit || plan.candidateTree !== review.candidateTree) throw new Error("Git CI plan does not match its reviewed snapshot");
  const { reviewId: _id, createdAt, ...identity } = review;
  return createAuthoritativeNativeReviewEnvelope({ identity, createdAt, policyDigest: plan.policyDigest,
    qualityRevision: plan.qualityRevision, requiredJobs: plan.requiredJobs, planning: plan.planning });
}
export async function readAuthoritativeNativeReviewEnvelope(repository: string, reviewId: string): Promise<AuthoritativeNativeReviewEnvelope | undefined> {
  const review = await readReview(repository, reviewId);
  return review === undefined ? undefined : gitCiEnvelope(repository, review);
}
export async function readAuthoritativeNativeReviewEnvelopes(repository: string): Promise<readonly AuthoritativeNativeReviewEnvelope[]> {
  const envelopes = await Promise.all((await readReviews(repository)).map((review) => gitCiEnvelope(repository, review)));
  return envelopes.filter((value): value is AuthoritativeNativeReviewEnvelope => value !== undefined);
}
export const assertAuthoritativeNativeReviewStore = assertReviewStore;
