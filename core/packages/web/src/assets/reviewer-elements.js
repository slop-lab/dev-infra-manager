export function reviewerElements() {
  const ids = [
    "restore-state", "login-view", "login-form", "login-button", "login-error", "status-announcer",
    "alert-announcer", "username", "password", "session-actions", "reviewer-label", "logout-button",
    "workspace", "workspace-title", "scope-project", "scope-reviewer", "repository", "create-form",
    "create-button", "protected-ref", "proposal-ref", "open-form", "open-button", "review-id",
    "request-error", "retry-button", "empty-state", "loading-state", "error-state", "error-title",
    "error-detail", "review-view", "review-title", "review-status", "stale-panel", "stale-reasons",
    "review-metadata", "decision-panel", "decision-status", "decision-error", "approve-button",
    "revoke-button", "path-count", "changed-paths", "patch-code", "patch-error", "patch-region",
    "patch-cue", "patch-thumb"
  ];
  const found = Object.fromEntries(ids.map((id) => [id, document.querySelector(`#${id}`)]));
  return {
    restore: found["restore-state"], loginView: found["login-view"], loginForm: found["login-form"],
    loginButton: found["login-button"], loginError: found["login-error"], statusAnnouncer: found["status-announcer"],
    alertAnnouncer: found["alert-announcer"], username: found.username, password: found.password,
    sessionActions: found["session-actions"], reviewerLabel: found["reviewer-label"], logoutButton: found["logout-button"],
    workspace: found.workspace, workspaceTitle: found["workspace-title"], scopeProject: found["scope-project"],
    scopeReviewer: found["scope-reviewer"], repository: found.repository, createForm: found["create-form"],
    createButton: found["create-button"], protectedRef: found["protected-ref"], proposalRef: found["proposal-ref"],
    openForm: found["open-form"], openButton: found["open-button"], reviewId: found["review-id"],
    requestError: found["request-error"], retryButton: found["retry-button"], emptyState: found["empty-state"],
    loadingState: found["loading-state"], errorState: found["error-state"], errorTitle: found["error-title"],
    errorDetail: found["error-detail"], reviewView: found["review-view"], reviewTitle: found["review-title"],
    reviewStatus: found["review-status"], stalePanel: found["stale-panel"], staleReasons: found["stale-reasons"],
    metadata: found["review-metadata"], decisionPanel: found["decision-panel"], decisionStatus: found["decision-status"],
    decisionError: found["decision-error"], approveButton: found["approve-button"], revokeButton: found["revoke-button"],
    pathCount: found["path-count"], changedPaths: found["changed-paths"], patchCode: found["patch-code"],
    patchError: found["patch-error"], patchRegion: found["patch-region"], patchCue: found["patch-cue"],
    patchTrack: document.querySelector(".patch-track"), patchThumb: found["patch-thumb"]
  };
}
