import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { readAuthoritativeNativeReviewEnvelopes } from "./authoritative-native-review-store.js";
import { readNativeProjectRegistrations, type NativeGitBundleState } from "./native-bundle-state.js";
import { readNativeProjectRootPromotionFinalized } from "./native-project-root-promotion-state.js";
import type { ExternalWebhookEvent } from "./external-webhook-store.js";

/** Read only durable authority records. A restart can backfill a commit-to-outbox crash window. */
export async function readExternalWebhookEvents(state: NativeGitBundleState, source: string): Promise<readonly {
  readonly projectId: string; readonly event: ExternalWebhookEvent;
}[]> {
  const events: { projectId: string; event: ExternalWebhookEvent }[] = [];
  for (const registration of readNativeProjectRegistrations(state)) {
    const { projectId, repositoryId } = registration;
    const repository = join(dirname(state.database), projectId, `${registration.repositoryId}.git`);
    for (const { review } of await readAuthoritativeNativeReviewEnvelopes(repository)) {
      events.push({ projectId, event: event(source, "dev.dim.git.review.created", projectId, repositoryId, review.reviewId, {
        projectId, reviewId: review.reviewId, repositoryId, proposalRef: review.proposalRef,
        protectedRef: review.protectedRef, expectedCommit: review.expectedProtectedHead,
        candidateCommit: review.candidateCommit, candidateTree: review.candidateTree,
        policyRevision: review.policyRevision, createdAt: review.createdAt
      }) });
    }
  }
  for (const promotion of readNativeProjectRootPromotionFinalized(state.database)) {
    const { projectId, repositoryId } = promotion;
    events.push({ projectId, event: event(source, "dev.dim.git.ref.promoted", projectId, repositoryId, promotion.transitionId, {
      projectId, repositoryId, reviewId: promotion.reviewId, transitionId: promotion.transitionId,
      sequence: promotion.sequence, proposalRef: promotion.proposalRef, protectedRef: promotion.protectedRef,
      expectedCommit: promotion.expectedCommit, candidateCommit: promotion.candidateCommit,
      candidateTree: promotion.candidateTree, generationId: promotion.decisionGeneration
    }) });
  }
  return events;
}
function event(source: string, type: ExternalWebhookEvent["type"], projectId: string, repositoryId: string, identity: string,
  data: ExternalWebhookEvent["data"]): ExternalWebhookEvent {
  return { specversion: "1.0", source, type,
    id: createHash("sha256").update(JSON.stringify([source, type, projectId, repositoryId, identity])).digest("hex"),
    subject: `projects/${projectId}/repositories/${repositoryId}`, datacontenttype: "application/json", data };
}
