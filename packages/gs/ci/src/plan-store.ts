import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";
import { readAuthoritativeNativeReviewEnvelope as readReview, readAuthoritativeNativeReviewEnvelopes as readReviews,
  assertAuthoritativeNativeReviewStore as assertReviewStore, type AuthoritativeNativeReviewEnvelope as ReviewEnvelope,
  assertVerifiedCiReviewSourceCurrent, ownedReviewDirectory,
  readReviewJson, writeImmutableReviewRecord, type ReviewAttachment,
  type VerifiedCiReviewSource } from "@slop-lab/gs-review";
import { gitCiPlanningSchema, authoritativeNativeRequiredJobSchema, createAuthoritativeNativeReviewEnvelope,
  createAuthoritativeNativeReviewDeliveryProjection, type AuthoritativeNativeReviewDeliveryProjection,
  type AuthoritativeNativeReviewEnvelope } from "./plan-schema.js";
import { assertPrivateGitCiPlanDirectory, readGitCiPlanFile, sameGitCiPlanFileVersion,
  type GitCiPlanFileVersion } from "./plan-file-version.js";
import { CoalescedAsyncOperations } from "./coalesced-async-operations.js";
import { PlanPathAttestations } from "./plan-path-attestations.js";
import { BoundedProjectionCache } from "./plan-projection-cache.js";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const maximumPlanBytes = 8 * 1024 * 1024;
const maximumProjectionEntries = 1_024;
const maximumProjectionBytes = 8 * 1024 * 1024;
const maximumPlanAttestationEntries = 100_000;
const maximumPlanAttestationBytes = 64 * 1024 * 1024;
export const gitCiPlanSchema = z.object({ schemaVersion: z.literal(1),
  projectId: z.string(), repositoryId: z.string(), expectedProtectedHead: objectId,
  candidateCommit: objectId, candidateTree: objectId, policyDigest: digest, qualityRevision: digest,
  requiredJobs: z.array(authoritativeNativeRequiredJobSchema).max(64).readonly(), planning: gitCiPlanningSchema
}).strict().readonly();
export type GitCiPlan = z.infer<typeof gitCiPlanSchema>;
function planDigest(plan: GitCiPlan): string {
  return createHash("sha256").update("dim-git-ci-plan-v1\0").update(JSON.stringify(plan)).digest("hex");
}
export type VerifiedGitCiDeliveryProjection = AuthoritativeNativeReviewDeliveryProjection;
type LoadedPlan = {
  readonly plan: GitCiPlan;
  readonly version: GitCiPlanFileVersion;
};
const projectionCache = new BoundedProjectionCache<VerifiedCiReviewSource, VerifiedGitCiDeliveryProjection>(
  maximumProjectionEntries,
  maximumProjectionBytes
);
const planAttestations = new PlanPathAttestations(maximumPlanAttestationEntries, maximumPlanAttestationBytes);
const planReads = new CoalescedAsyncOperations<string, LoadedPlan>();
const projectionLoads = new CoalescedAsyncOperations<VerifiedCiReviewSource, VerifiedGitCiDeliveryProjection>();
export async function saveGitCiPlan(repository: string, input: GitCiPlan): Promise<ReviewAttachment> {
  const plan = gitCiPlanSchema.parse(input), digest = planDigest(plan);
  if (Buffer.byteLength(JSON.stringify(plan)) > maximumPlanBytes) throw new Error("Git CI plan exceeds its storage bound");
  const root = join(repository, "dim-git-ci-plans"); await ownedReviewDirectory(root);
  const path = join(root, `${digest}.json`);
  try { await writeImmutableReviewRecord(path, plan); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const previous = gitCiPlanSchema.parse(await readReviewJson(path, maximumPlanBytes, true));
    if (planDigest(previous) !== digest) throw new Error("Git CI plan storage conflicts");
  }
  return { kind: "git-ci", id: digest, digest };
}
export async function readVerifiedGitCiDeliveryProjection(
  repository: string,
  source: VerifiedCiReviewSource
): Promise<VerifiedGitCiDeliveryProjection | undefined> {
  await assertVerifiedCiReviewSourceCurrent(repository, source);
  const attachments = source.summary.attachments.filter(({ kind }) => kind === "git-ci");
  if (attachments.length === 0) return undefined;
  if (attachments.length !== 1) throw new Error("review has conflicting Git CI attachments");
  const attachment = attachments[0];
  if (attachment === undefined || !/^[0-9a-f]{64}$/.test(attachment.id) || attachment.digest !== attachment.id) {
    throw new Error("Git CI attachment identity is invalid");
  }
  const root = resolve(repository, "dim-git-ci-plans");
  await assertPrivateGitCiPlanDirectory(root);
  const path = join(root, `${attachment.id}.json`);
  const attestation = planAttestations.expected(path);
  const cached = projectionCache.get(source);
  if (cached !== undefined) {
    if (cached.attachmentId !== attachment.id || attestation === undefined) {
      throw new Error("Git CI projection attestation is unavailable");
    }
    const current = await readGitCiPlanFile({ path, maximumBytes: maximumPlanBytes,
      expectedVersion: attestation, readBody: false });
    if (!sameGitCiPlanFileVersion(current.version, attestation)) throw new Error("Git CI plan version changed");
    await assertVerifiedCiReviewSourceCurrent(repository, source);
    projectionCache.touch(source, cached);
    return cached.value;
  }
  return projectionLoads.run(source, async () => {
    const record = await planReads.run(path, async () => {
      const expectedVersion = planAttestations.expected(path);
      const file = await readGitCiPlanFile({ path, maximumBytes: maximumPlanBytes,
        ...(expectedVersion === undefined ? {} : { expectedVersion }), readBody: true });
      if (file.serialized === undefined) throw new Error("Git CI plan body is unavailable");
      return { version: file.version, plan: gitCiPlanSchema.parse(JSON.parse(file.serialized)) };
    });
    assertPlanMatchesSource(record.plan, attachment, source);
    const projection = createAuthoritativeNativeReviewDeliveryProjection({
      review: source.summary.review, qualityRevision: record.plan.qualityRevision,
      policyDigest: record.plan.policyDigest, requiredJobs: record.plan.requiredJobs, planning: record.plan.planning
    });
    await assertVerifiedCiReviewSourceCurrent(repository, source);
    await readGitCiPlanFile({ path, maximumBytes: maximumPlanBytes,
      expectedVersion: record.version, readBody: false });
    planAttestations.attest(path, record.version);
    projectionCache.set(source, attachment.id, projection);
    return projection;
  });
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

function assertPlanMatchesSource(plan: GitCiPlan, attachment: ReviewAttachment, source: VerifiedCiReviewSource): void {
  const review = source.summary.review;
  if (planDigest(plan) !== attachment.digest || plan.policyDigest !== source.summary.policyDigest
    || plan.projectId !== review.projectId || plan.repositoryId !== review.repositoryId
    || plan.expectedProtectedHead !== review.expectedProtectedHead
    || plan.candidateCommit !== review.candidateCommit || plan.candidateTree !== review.candidateTree) {
    throw new Error("Git CI plan does not match its reviewed snapshot");
  }
}
