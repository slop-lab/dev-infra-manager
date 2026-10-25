import type { ReviewDto } from "@slop-lab/dim-service-client-native-git";
import type { WebPluginUi } from "@slop-lab/dim-web/plugin-api";
import { reviewCiSummary } from "./review-ci.js";

type ReviewCiRenderer = {
  readonly detail: HTMLElement;
  readonly review: ReviewDto;
  readonly ui: WebPluginUi;
  readonly element: WebPluginUi["element"];
};
export type ReviewApprovalEvidence = Pick<ReviewDto, "status" | "requiredReviewerIds" | "approvals" | "revocations">;
export type ReviewApprovalAccess = {
  readonly reviewerId?: string | undefined;
  readonly browserCanApprove: boolean;
  readonly controllerCanApprove: boolean;
};

export function reviewApprovalAvailability(review: ReviewApprovalEvidence, access: ReviewApprovalAccess) {
  if (review.status === "stale") return { state: "stale", message: "This review is stale. Resolve the proposal again to inspect current changes before approving." } as const;
  if (!review.requiredReviewerIds.length) return { state: "not-required", message: "No human approval is required for these changes. The candidate can be promoted when its other requirements are satisfied." } as const;
  if (!access.controllerCanApprove || !access.reviewerId) return { state: "connection-required", message: "This controller has no available approval connection. Ask its operator to connect the required reviewer, then reconnect Git review." } as const;
  if (!review.requiredReviewerIds.includes(access.reviewerId)) return { state: "identity-mismatch", message: `Approval is required from ${review.requiredReviewerIds.join(", ")}. This controller is connected as ${access.reviewerId}; use a controller connected to a required reviewer.` } as const;
  if (review.approvals.some((approval) => approval.reviewerId === access.reviewerId && !review.revocations.some((revocation) => revocation.approvalId === approval.approvalId))) return { state: "already-approved", message: "Your approval is already recorded for this exact candidate." } as const;
  if (!access.browserCanApprove) return { state: "role-required", message: "Your Web account does not have the reviewer role. Open Account & access, edit your account's roles, select Grant reviewer, enter your current password and save, then sign in again. If you cannot manage accounts, ask an account administrator." } as const;
  return { state: "available", message: `You can approve this exact candidate as ${access.reviewerId}.` } as const;
}

export function appendReviewCi(input: ReviewCiRenderer): void {
  const { detail, review, ui, element } = input;
  const section = element("section", "", "review-ci");
  section.append(element("h4", "DIM CI"));
  const summary = element("p", reviewCiSummary(review.ci), "workspace-feedback");
  summary.setAttribute("role", "status");
  summary.dataset.ciState = review.ci?.state ?? "unavailable";
  section.append(summary);
  if (review.ci?.requiredJobs.length) section.append(ui.table(["Required job", "Execution kind", "Status", "Execution"],
    review.ci.requiredJobs.map((job) => [job.name, job.kind, job.status, job.executionId ?? "Not assigned"])));
  detail.append(section);
}
