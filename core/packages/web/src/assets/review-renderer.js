const MAX_HIGHLIGHTED_LINES = 5_000;
const MAX_PATCH_LINES = 250_000;
const MAX_PATCH_BYTES = 8 * 1024 * 1024;

function statusClass(status) {
  switch (status) {
    case "pending": return "badge badge-pending";
    case "approved": return "badge badge-approved";
    case "revoked": return "badge badge-error";
    case "stale": return "badge badge-info";
    default: return "badge badge-neutral";
  }
}

function appendMetadata(container, label, value, mono = false) {
  const row = document.createElement("div");
  const term = document.createElement("dt");
  const detail = document.createElement("dd");
  term.textContent = label;
  detail.textContent = value;
  if (mono) detail.classList.add("mono");
  row.append(term, detail);
  container.append(row);
}

export function renderReview(elements, review, reviewerId) {
  const { input, changes, requiredReviewerIds, staleReasons, approvals, revocations, canDecide } = review;
  elements.reviewId.value = input.reviewId;
  elements.reviewTitle.textContent = `Review ${input.reviewId.slice(0, 12)}`;
  elements.reviewStatus.className = statusClass(input.status);
  elements.reviewStatus.textContent = input.status[0].toUpperCase() + input.status.slice(1);
  elements.stalePanel.hidden = input.status !== "stale";
  elements.staleReasons.replaceChildren(...staleReasons.map((reason) => {
    const item = document.createElement("li");
    item.textContent = reason;
    return item;
  }));
  elements.metadata.replaceChildren();
  const values = [
    ["Project", input.projectId], ["Repository", input.repositoryId], ["Protected ref", input.protectedRef],
    ["Proposal ref", input.proposalRef], ["Expected head", input.expectedProtectedHead, true],
    ["Candidate commit", input.candidateCommit, true], ["Candidate tree", input.candidateTree, true],
    ["Policy revision", input.policyRevision], ["Review revision", input.requiredReviewRevision],
    ["Required job set", input.requiredJobSetRevision], ["Workspace", input.workspaceId],
    ["Required reviewers", requiredReviewerIds.join(", ")], ["Created", input.createdAt]
  ];
  for (const value of values) appendMetadata(elements.metadata, value[0], value[1], value[2] === true);
  renderDecision(elements, input.status, reviewerId, approvals, revocations, canDecide);
  elements.pathCount.textContent = `${changes.length} ${changes.length === 1 ? "path" : "paths"}`;
  elements.changedPaths.replaceChildren(...changes.map((change) => {
    const item = document.createElement("li");
    const kind = document.createElement("span");
    const path = document.createElement("span");
    kind.className = "path-kind";
    path.className = "path-value";
    kind.textContent = change.status;
    const value = change.oldPath !== null && change.newPath !== null && change.oldPath !== change.newPath ? `${change.oldPath} -> ${change.newPath}` : change.newPath ?? change.oldPath;
    const segments = value.match(/[^/_-]*[/_-]|[^/_-]+$/gu) ?? [];
    for (const [index, segment] of segments.entries()) {
      path.append(document.createTextNode(segment));
      if (index < segments.length - 1) {
        const breakPoint = document.createElement("wbr");
        breakPoint.className = "path-break";
        path.append(breakPoint);
      }
    }
    item.append(kind, path);
    return item;
  }));
  return renderPatch(elements, input.patch);
}

export function clearReview(elements) {
  for (const container of [elements.staleReasons, elements.metadata, elements.changedPaths, elements.patchCode, elements.repository]) {
    container.replaceChildren();
  }
  for (const input of [elements.password, elements.protectedRef, elements.proposalRef, elements.reviewId]) input.value = "";
  for (const output of [elements.reviewerLabel, elements.scopeProject, elements.scopeReviewer, elements.requestError,
    elements.errorTitle, elements.errorDetail, elements.reviewTitle, elements.reviewStatus, elements.pathCount,
    elements.patchError, elements.patchCue, elements.decisionStatus, elements.decisionError]) output.textContent = "";
  elements.reviewStatus.className = "";
  elements.stalePanel.hidden = true;
  elements.loadingState.hidden = true;
  elements.errorState.hidden = true;
  elements.reviewView.hidden = true;
  elements.decisionPanel.hidden = true;
  elements.patchRegion.hidden = true;
  elements.patchError.hidden = true;
  elements.retryButton.hidden = true;
  elements.emptyState.hidden = false;
  elements.statusAnnouncer.textContent = "No review is open.";
  elements.loginButton.classList.remove("is-loading");
}

function renderDecision(elements, status, reviewerId, approvals, revocations, canDecide) {
  const revokedIds = new Set(revocations.map(({ approvalId }) => approvalId));
  const ownApprovals = approvals.filter((approval) => approval.reviewerId === reviewerId);
  const active = ownApprovals.find(({ approvalId }) => !revokedIds.has(approvalId));
  const hadRevoked = ownApprovals.some(({ approvalId }) => revokedIds.has(approvalId));
  elements.decisionPanel.hidden = false;
  if (!canDecide) {
    elements.approveButton.hidden = true;
    elements.revokeButton.hidden = true;
    elements.decisionError.textContent = "";
    elements.decisionStatus.textContent = "This account can inspect evidence but cannot record a review decision.";
    return;
  }
  elements.approveButton.hidden = active !== undefined;
  elements.approveButton.disabled = status === "stale";
  elements.revokeButton.hidden = active === undefined;
  elements.decisionError.textContent = "";
  elements.decisionStatus.textContent = active !== undefined
    ? "Your approval is recorded for this exact review."
    : status === "stale"
      ? "This evidence is stale and cannot be approved."
      : hadRevoked
        ? "Your approval has been revoked."
        : "You have not approved this exact review.";
}

function renderPatch(elements, patch) {
  let lineCount = patch.length === 0 ? 0 : 1;
  for (const character of patch) {
    if (character === "\n") lineCount += 1;
    if (lineCount > MAX_PATCH_LINES) break;
  }
  const complete = new TextEncoder().encode(patch).byteLength <= MAX_PATCH_BYTES && lineCount <= MAX_PATCH_LINES;
  elements.patchError.hidden = complete;
  elements.patchRegion.hidden = !complete;
  if (!complete) {
    elements.patchCode.replaceChildren();
    elements.patchError.textContent = "This patch exceeds the browser full-evidence limit. No partial patch is shown; inspect the immutable review through the native reviewer surface.";
    elements.alertAnnouncer.textContent = elements.patchError.textContent;
    return { complete: false };
  }

  elements.alertAnnouncer.textContent = "";

  const chunks = patch.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (chunks.length > MAX_HIGHLIGHTED_LINES) {
    elements.patchCode.replaceChildren(document.createTextNode(patch));
    return { complete: true };
  }
  elements.patchCode.replaceChildren(...chunks.map((chunk) => {
    const row = document.createElement("span");
    row.className = chunk.startsWith("@@") ? "patch-line patch-line-hunk" : chunk.startsWith("+") && !chunk.startsWith("+++") ? "patch-line patch-line-add" : chunk.startsWith("-") && !chunk.startsWith("---") ? "patch-line patch-line-del" : "patch-line";
    row.textContent = chunk;
    return row;
  }));
  return { complete: true };
}
