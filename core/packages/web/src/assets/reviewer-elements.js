// @ts-check

/**
 * @template {HTMLElement} T
 * @param {string} selector
 * @param {{new(): T}} constructor
 * @returns {T}
 */
function element(selector, constructor) {
  const found = document.querySelector(selector);
  if (!(found instanceof constructor)) throw new Error(`Missing reviewer element: ${selector}`);
  return found;
}

export function reviewerElements() {
  return {
    restore: element("#restore-state", HTMLElement), loginView: element("#login-view", HTMLElement), loginForm: element("#login-form", HTMLFormElement),
    loginButton: element("#login-button", HTMLButtonElement), loginError: element("#login-error", HTMLElement), statusAnnouncer: element("#status-announcer", HTMLElement),
    alertAnnouncer: element("#alert-announcer", HTMLElement), username: element("#username", HTMLInputElement), password: element("#password", HTMLInputElement),
    sessionActions: element("#session-actions", HTMLElement), reviewerLabel: element("#reviewer-label", HTMLElement), logoutButton: element("#logout-button", HTMLButtonElement),
    workspace: element("#workspace", HTMLElement), workspaceTitle: element("#workspace-title", HTMLElement), scopeProject: element("#scope-project", HTMLElement),
    scopeReviewer: element("#scope-reviewer", HTMLElement), createForm: element("#create-form", HTMLFormElement),
    createButton: element("#create-button", HTMLButtonElement), proposalRef: element("#proposal-ref", HTMLInputElement),
    openForm: element("#open-form", HTMLFormElement), openButton: element("#open-button", HTMLButtonElement), reviewId: element("#review-id", HTMLInputElement),
    requestError: element("#request-error", HTMLElement), retryButton: element("#retry-button", HTMLButtonElement), emptyState: element("#empty-state", HTMLElement),
    loadingState: element("#loading-state", HTMLElement), errorState: element("#error-state", HTMLElement), errorTitle: element("#error-title", HTMLElement),
    errorDetail: element("#error-detail", HTMLElement), reviewView: element("#review-view", HTMLElement), reviewTitle: element("#review-title", HTMLElement),
    reviewStatus: element("#review-status", HTMLElement), stalePanel: element("#stale-panel", HTMLElement), staleReasons: element("#stale-reasons", HTMLElement),
    metadata: element("#review-metadata", HTMLElement), decisionPanel: element("#decision-panel", HTMLElement), decisionStatus: element("#decision-status", HTMLElement),
    decisionError: element("#decision-error", HTMLElement), approveButton: element("#approve-button", HTMLButtonElement), revokeButton: element("#revoke-button", HTMLButtonElement),
    pathCount: element("#path-count", HTMLElement), changedPaths: element("#changed-paths", HTMLElement), patchCode: element("#patch-code", HTMLElement),
    patchError: element("#patch-error", HTMLElement), patchRegion: element("#patch-region", HTMLElement), patchCue: element("#patch-cue", HTMLElement),
    patchTrack: element(".patch-track", HTMLElement), patchThumb: element("#patch-thumb", HTMLElement)
  };
}
