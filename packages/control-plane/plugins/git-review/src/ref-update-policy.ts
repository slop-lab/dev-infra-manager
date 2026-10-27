import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { refUpdatePolicyExtension, type RefUpdatePolicy } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { codeReviewPolicySchema } from "./policy.js";
import { reviewChangeMatchers } from "./change-matchers.js";
import { nativeHumanReviewStaleReasons } from "./native-human-reviewer-freshness.js";
import { readAuthoritativeNativeReviewEnvelopes } from "./authoritative-native-review-store.js";
import { readAuthoritativeNativeDecisions } from "./authoritative-native-decision-store.js";
import { hasPendingProposalAcceptance } from "./proposal-acceptance.js";

const revision = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
const policy: RefUpdatePolicy = {
  name: "code-review", revision,
  validate(options) { codeReviewPolicySchema.parse(options); },
  async check({ context, target, change }) {
    const runtime = { ...context.runtime, reviewChangeMatchers: reviewChangeMatchers(context.extensions) };
    const reviews = await readAuthoritativeNativeReviewEnvelopes(target.repository);
    for (const envelope of reviews) {
      const { review } = envelope;
      if (review.projectId !== change.projectId || review.repositoryId !== change.repositoryId
        || review.proposalRef !== change.proposalRef || review.protectedRef !== target.currentHead.protectedRef
        || review.expectedProtectedHead !== change.expectedCommit || review.candidateCommit !== change.candidateCommit
        || review.candidateTree !== change.candidateTree || envelope.policyDigest !== target.imported.policyDigest) continue;
      if (await hasPendingProposalAcceptance(target.repository, context.runtime.expectedGenerationId, envelope)) continue;
      if ((await nativeHumanReviewStaleReasons(runtime, target, review)).length > 0) continue;
      const decisions = await readAuthoritativeNativeDecisions(target.repository, review.reviewId);
      const reviewers = decisions.activeApprovals.map(({ reviewerId }) => reviewerId).sort();
      if (JSON.stringify(reviewers) === JSON.stringify(review.requiredReviewerIds)) return;
    }
    throw new Error("protected ref requires a current review and every required human approval");
  }
};
export const codeReviewRefUpdatePolicyExtension = refUpdatePolicyExtension(policy);
