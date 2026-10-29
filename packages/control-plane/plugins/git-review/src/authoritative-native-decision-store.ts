export {
  approveReview as approveAuthoritativeNativeReview,
  readReviewDecisions as readAuthoritativeNativeDecisions,
  revokeReviewApproval as revokeAuthoritativeNativeApproval,
  ReviewDecisionForbiddenError as AuthoritativeNativeDecisionForbiddenError,
  ReviewDecisionNotFoundError as AuthoritativeNativeDecisionNotFoundError,
  ReviewDecisionStoreError as AuthoritativeNativeDecisionStoreError,
  type ReviewDecisions as AuthoritativeNativeDecisions,
} from "@slop-lab/gs-review";
