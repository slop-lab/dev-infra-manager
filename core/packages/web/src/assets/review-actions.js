import { parseReview } from "./review-data.js";
import { renderReview } from "./review-renderer.js";
import { updatePatchPosition } from "./patch-position.js";

export function createReviewActions(elements, lifecycle) {
  async function mutate(action, button, inverseButton) {
    const session = lifecycle.session();
    if (session === null || lifecycle.isPending(button)) return;
    const reviewId = elements.reviewId.value;
    const repositoryId = elements.repository.value;
    const operation = lifecycle.startOperation(button);
    lifecycle.lockNavigation();
    const label = button.textContent;
    button.textContent = action === "approvals" ? "Approving review" : "Revoking approval";
    elements.decisionError.textContent = "";
    try {
      const result = await lifecycle.request(
        `/v1/projects/${encodeURIComponent(session.projectId)}/repositories/${encodeURIComponent(repositoryId)}/reviews/${encodeURIComponent(reviewId)}/${action}`,
        operation,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-DIM-CSRF": session.csrfToken },
          body: "{}"
        }
      );
      if (!lifecycle.isCurrent(operation)) return;
      if (result.status === 401) return lifecycle.showSignedOut("Your session ended. Sign in again.");
      const review = result.ok ? parseReview(result.body) : null;
      if (review === null) {
        const stale = result.status === 409 && action === "approvals";
        elements.decisionError.textContent = stale
          ? "Approval was denied because the exact review is stale. Reloading current evidence."
          : "The review decision could not be updated. Inspect the current evidence and retry.";
        elements.alertAnnouncer.textContent = elements.decisionError.textContent;
        if (stale) await lifecycle.openReview(reviewId, operation);
        return;
      }
      renderReview(elements, review, session.reviewerId);
      updatePatchPosition(elements);
      elements.statusAnnouncer.textContent = action === "approvals" ? "Approval recorded." : "Approval revoked.";
      inverseButton.focus();
    } finally {
      lifecycle.unlockNavigation();
      if (lifecycle.isCurrent(operation)) {
        button.textContent = label;
        lifecycle.endBusy(button);
      }
    }
  }

  return {
    approve: () => mutate("approvals", elements.approveButton, elements.revokeButton),
    revoke: () => mutate("revocations", elements.revokeButton, elements.approveButton)
  };
}
