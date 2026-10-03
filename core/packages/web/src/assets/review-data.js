function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function textList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

export function text(value) {
  return typeof value === "string" ? value : null;
}

export function parseSession(value) {
  const input = record(value);
  const projectId = text(input?.projectId);
  const repositoryIds = textList(input?.repositoryIds);
  const reviewerId = text(input?.reviewerId);
  const csrfToken = text(input?.csrfToken);
  if (input?.authenticated !== true || projectId === null || repositoryIds === null || repositoryIds.length === 0 || reviewerId === null || csrfToken === null) return null;
  return { projectId, repositoryIds, reviewerId, csrfToken };
}

export function parseReview(value) {
  const input = record(value);
  const changes = Array.isArray(input?.changes) ? input.changes.map(parseChange) : null;
  const requiredStrings = ["projectId", "repositoryId", "protectedRef", "proposalRef", "expectedProtectedHead", "candidateCommit", "candidateTree", "policyRevision", "requiredReviewRevision", "requiredJobSetRevision", "workspaceId", "reviewId", "createdAt", "status", "patch"];
  if (input === null || changes === null || changes.includes(null) || requiredStrings.some((key) => text(input[key]) === null)) return null;
  const staleReasons = textList(input.staleReasons);
  const requiredReviewerIds = textList(input.requiredReviewerIds);
  if (staleReasons === null || requiredReviewerIds === null || !["pending", "approved", "revoked", "stale"].includes(input.status) || !/^[0-9a-f]{64}$/.test(input.reviewId)) return null;
  return { input, changes, staleReasons, requiredReviewerIds };
}

function parseChange(value) {
  const input = record(value);
  const status = text(input?.status);
  const oldPath = input?.oldPath === undefined ? null : text(input.oldPath);
  const newPath = input?.newPath === undefined ? null : text(input.newPath);
  if (status === null || (oldPath === null && newPath === null)) return null;
  return { status, oldPath, newPath };
}
