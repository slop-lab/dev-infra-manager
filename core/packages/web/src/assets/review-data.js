// @ts-check

/** @param {unknown} value @returns {Record<string, unknown> | null} */
export function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/** @param {unknown} value @returns {string[] | null} */
function textList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

/** @param {unknown} value */
export function text(value) {
  return typeof value === "string" ? value : null;
}

/** @param {unknown} value */
export function parseSession(value) {
  const input = record(value);
  const projectId = text(input?.projectId);
  const reviewerId = text(input?.reviewerId);
  const csrfToken = text(input?.csrfToken);
  if (input?.authenticated !== true || projectId === null || reviewerId === null || csrfToken === null) return null;
  const capabilities = record(input.capabilities);
  const roles = textList(input.roles);
  if (!capabilities || !roles || typeof capabilities.review !== "boolean" || typeof capabilities.operations !== "boolean" || typeof capabilities.promotion !== "boolean") return null;
  return { projectId, reviewerId, csrfToken, roles, capabilities: { review: capabilities.review, operations: capabilities.operations, promotion: capabilities.promotion } };
}

/** @param {unknown} value */
export function parseReview(value) {
  const input = record(value);
  const changes = Array.isArray(input?.changes) ? input.changes.map(parseChange) : null;
  const approvals = Array.isArray(input?.approvals) ? input.approvals.map(parseApproval) : null;
  const revocations = Array.isArray(input?.revocations) ? input.revocations.map(parseRevocation) : null;
  const requiredStrings = /** @type {const} */ (["projectId", "repositoryId", "protectedRef", "proposalRef", "expectedProtectedHead", "candidateCommit", "candidateTree", "policyRevision", "requiredReviewRevision", "qualityRevision", "workspaceId", "reviewId", "createdAt", "status", "patch"]);
  if (input === null || typeof input.canDecide !== "boolean" || changes === null || !changes.every((item) => item !== null) || approvals === null || !approvals.every((item) => item !== null)
    || revocations === null || !revocations.every((item) => item !== null) || !hasStrings(input, requiredStrings)) return null;
  const staleReasons = textList(input.staleReasons);
  const requiredReviewerIds = textList(input.requiredReviewerIds);
  if (staleReasons === null || requiredReviewerIds === null || (input.status !== "pending" && input.status !== "approved" && input.status !== "revoked" && input.status !== "stale") || !/^[0-9a-f]{64}$/.test(input.reviewId)) return null;
  return { input, changes, staleReasons, requiredReviewerIds, approvals, revocations, canDecide: input.canDecide };
}

/** @param {unknown} value */
function parseChange(value) {
  const input = record(value);
  const status = text(input?.status);
  const oldPath = input?.oldPath === undefined ? null : text(input.oldPath);
  const newPath = input?.newPath === undefined ? null : text(input.newPath);
  if (status === null || (oldPath === null && newPath === null)) return null;
  return { status, oldPath, newPath };
}

/** @param {unknown} value */
function parseApproval(value) {
  const input = record(value);
  const approvalId = text(input?.approvalId);
  const reviewerId = text(input?.reviewerId);
  const approvedAt = text(input?.approvedAt);
  return approvalId === null || reviewerId === null || approvedAt === null ? null : { approvalId, reviewerId, approvedAt };
}

/** @param {unknown} value */
function parseRevocation(value) {
  const input = record(value);
  const approvalId = text(input?.approvalId);
  const revokedAt = text(input?.revokedAt);
  return approvalId === null || revokedAt === null ? null : { approvalId, revokedAt };
}

/**
 * @template {string} K
 * @param {Record<string, unknown>} input
 * @param {readonly K[]} keys
 * @returns {input is Record<string, unknown> & Record<K, string>}
 */
function hasStrings(input, keys) {
  return keys.every((key) => typeof input[key] === "string");
}
