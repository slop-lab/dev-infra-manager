"use strict";

import { parseReview, parseSession, text } from "./review-data.js";
import { clearReview, renderReview } from "./review-renderer.js";
import { createOperationCoordinator } from "./operation-coordinator.js";
import { updatePatchPosition } from "./patch-position.js";

const elements = {
  restore: document.querySelector("#restore-state"),
  loginView: document.querySelector("#login-view"),
  loginForm: document.querySelector("#login-form"),
  loginButton: document.querySelector("#login-button"),
  loginError: document.querySelector("#login-error"),
  statusAnnouncer: document.querySelector("#status-announcer"),
  alertAnnouncer: document.querySelector("#alert-announcer"),
  username: document.querySelector("#username"),
  password: document.querySelector("#password"),
  sessionActions: document.querySelector("#session-actions"),
  reviewerLabel: document.querySelector("#reviewer-label"),
  logoutButton: document.querySelector("#logout-button"),
  workspace: document.querySelector("#workspace"),
  workspaceTitle: document.querySelector("#workspace-title"),
  scopeProject: document.querySelector("#scope-project"),
  scopeReviewer: document.querySelector("#scope-reviewer"),
  repository: document.querySelector("#repository"),
  createForm: document.querySelector("#create-form"),
  createButton: document.querySelector("#create-button"),
  protectedRef: document.querySelector("#protected-ref"),
  proposalRef: document.querySelector("#proposal-ref"),
  openForm: document.querySelector("#open-form"),
  openButton: document.querySelector("#open-button"),
  reviewId: document.querySelector("#review-id"),
  requestError: document.querySelector("#request-error"),
  retryButton: document.querySelector("#retry-button"),
  emptyState: document.querySelector("#empty-state"),
  loadingState: document.querySelector("#loading-state"),
  errorState: document.querySelector("#error-state"),
  errorTitle: document.querySelector("#error-title"),
  errorDetail: document.querySelector("#error-detail"),
  reviewView: document.querySelector("#review-view"),
  reviewTitle: document.querySelector("#review-title"),
  reviewStatus: document.querySelector("#review-status"),
  stalePanel: document.querySelector("#stale-panel"),
  staleReasons: document.querySelector("#stale-reasons"),
  metadata: document.querySelector("#review-metadata"),
  pathCount: document.querySelector("#path-count"),
  changedPaths: document.querySelector("#changed-paths"),
  patchCode: document.querySelector("#patch-code"),
  patchError: document.querySelector("#patch-error"),
  patchRegion: document.querySelector("#patch-region"),
  patchCue: document.querySelector("#patch-cue"),
  patchTrack: document.querySelector(".patch-track"),
  patchThumb: document.querySelector("#patch-thumb")
};

let session = null;
let retryAction = null;
const pendingControls = new Set();
const operations = createOperationCoordinator();

async function request(path, operation, options = {}) {
  try {
    const response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      headers: { Accept: "application/json", ...options.headers },
      signal: AbortSignal.any([operation.signal, AbortSignal.timeout(10_000)])
    });
    const body = response.status === 204 ? null : await response.json();
    return { body, ok: response.ok, status: response.status };
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError || error instanceof DOMException) return { body: null, ok: false, status: 0 };
    throw error;
  }
}

function showSignedOut(message = "") {
  session = null;
  startOperation();
  retryAction = null;
  clearReview(elements);
  elements.restore.hidden = true;
  elements.workspace.hidden = true;
  elements.sessionActions.hidden = true;
  elements.loginView.hidden = false;
  elements.loginError.textContent = message;
  elements.alertAnnouncer.textContent = message;
  elements.username.setAttribute("aria-invalid", String(message.startsWith("Sign-in")));
  elements.password.setAttribute("aria-invalid", String(message.startsWith("Sign-in")));
  elements.username.focus();
}

function showWorkspace(activeSession) {
  session = activeSession;
  elements.restore.hidden = true;
  elements.loginView.hidden = true;
  elements.workspace.hidden = false;
  elements.sessionActions.hidden = false;
  elements.scopeProject.textContent = activeSession.projectId;
  elements.scopeReviewer.textContent = activeSession.reviewerId;
  elements.reviewerLabel.textContent = activeSession.reviewerId;
  elements.alertAnnouncer.textContent = "";
  elements.password.value = "";
  elements.username.removeAttribute("aria-invalid");
  elements.password.removeAttribute("aria-invalid");
  elements.repository.replaceChildren();
  for (const repositoryId of activeSession.repositoryIds) {
    const option = document.createElement("option");
    option.value = repositoryId;
    option.textContent = repositoryId;
    elements.repository.append(option);
  }
  elements.workspaceTitle.focus();
}

function beginBusy(button) {
  if (pendingControls.has(button)) return false;
  pendingControls.add(button);
  button.setAttribute("aria-busy", "true");
  button.setAttribute("aria-disabled", "true");
  return true;
}

function endBusy(button) {
  pendingControls.delete(button);
  button.removeAttribute("aria-busy");
  button.removeAttribute("aria-disabled");
}

function startOperation(button = null) {
  for (const pending of pendingControls) endBusy(pending);
  const operation = operations.start();
  if (button !== null) beginBusy(button);
  return operation;
}

function showRequestError(message, retry, title = "Evidence request failed") {
  elements.requestError.textContent = message;
  elements.alertAnnouncer.textContent = message;
  elements.errorTitle.textContent = title;
  elements.errorDetail.textContent = message;
  retryAction = retry;
  elements.retryButton.hidden = retry === null;
}

function showEvidenceState(state) {
  elements.emptyState.hidden = state !== "empty";
  elements.loadingState.hidden = state !== "loading";
  elements.errorState.hidden = state !== "error";
  elements.reviewView.hidden = state !== "ready";
  elements.statusAnnouncer.textContent = state === "loading" ? "Loading review evidence." : state === "ready" ? "Review evidence loaded." : state === "error" ? "Review evidence could not be loaded." : "No review is open.";
}

async function openReview(reviewId, operation) {
  if (session === null) return;
  showEvidenceState("loading");
  showRequestError("", null);
  const repositoryId = elements.repository.value;
  const result = await request(`/v1/projects/${encodeURIComponent(session.projectId)}/repositories/${encodeURIComponent(repositoryId)}/reviews/${encodeURIComponent(reviewId)}`, operation);
  if (!operations.isCurrent(operation)) return;
  if (result.status === 401) return showSignedOut("Your session ended. Sign in again.");
  const review = result.ok ? parseReview(result.body) : null;
  if (review === null) {
    showEvidenceState("error");
    showRequestError(
      result.status === 404 ? "That review was not found in this configured repository." : "Review evidence could not be loaded. Check the connection and retry.",
      () => void openReview(reviewId, startOperation())
    );
    elements.errorTitle.focus();
    return;
  }
  const rendered = renderReview(elements, review);
  showEvidenceState("ready");
  updatePatchPosition(elements);
  if (!rendered.complete) elements.statusAnnouncer.textContent = "Full patch evidence is unavailable in this browser view.";
  (rendered.complete ? elements.reviewTitle : elements.patchError).focus();
}

elements.patchRegion.addEventListener("scroll", () => updatePatchPosition(elements), { passive: true });
window.addEventListener("resize", () => updatePatchPosition(elements), { passive: true });

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!elements.loginForm.reportValidity()) return;
  if (pendingControls.has(elements.loginButton)) return;
  const operation = startOperation(elements.loginButton);
  elements.loginButton.classList.add("is-loading");
  elements.loginError.textContent = "";
  elements.username.removeAttribute("aria-invalid");
  elements.password.removeAttribute("aria-invalid");
  try {
    const result = await request("/v1/session", operation, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: elements.username.value, password: elements.password.value }) });
    if (!operations.isCurrent(operation)) return;
    const activeSession = result.ok ? parseSession(result.body) : null;
    if (activeSession === null) return showSignedOut("Sign-in failed. Check your credentials and try again.");
    showWorkspace(activeSession);
  } finally {
    if (operations.isCurrent(operation)) {
      endBusy(elements.loginButton);
      elements.loginButton.classList.remove("is-loading");
    }
  }
});

elements.createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (session === null || !elements.createForm.reportValidity()) return;
  if (pendingControls.has(elements.createButton)) return;
  const operation = startOperation(elements.createButton);
  showEvidenceState("loading");
  showRequestError("", null);
  try {
    const result = await request(`/v1/projects/${encodeURIComponent(session.projectId)}/repositories/${encodeURIComponent(elements.repository.value)}/reviews`, operation, { method: "POST", headers: { "Content-Type": "application/json", "X-DIM-CSRF": session.csrfToken }, body: JSON.stringify({ protectedRef: elements.protectedRef.value, proposalRef: elements.proposalRef.value }) });
    if (!operations.isCurrent(operation)) return;
    if (result.status === 401) return showSignedOut("Your session ended. Sign in again.");
    const created = typeof result.body === "object" && result.body !== null && !Array.isArray(result.body) ? result.body : null;
    const reviewId = text(created?.reviewId);
    if (!result.ok || reviewId === null) {
      showEvidenceState("error");
      showRequestError("Review evidence could not be created. The entered refs were preserved; verify them and retry.", () => elements.createForm.requestSubmit());
      elements.errorTitle.focus();
      return;
    }
     await openReview(reviewId, operation);
  } finally {
    if (operations.isCurrent(operation)) endBusy(elements.createButton);
  }
});

elements.openForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!elements.openForm.reportValidity()) return;
  if (pendingControls.has(elements.openButton)) return;
  const operation = startOperation(elements.openButton);
  try { await openReview(elements.reviewId.value, operation); } finally {
    if (operations.isCurrent(operation)) endBusy(elements.openButton);
  }
});

elements.logoutButton.addEventListener("click", async () => {
  if (session === null) return;
  if (pendingControls.has(elements.logoutButton)) return;
  const operation = startOperation(elements.logoutButton);
  try {
    const result = await request("/v1/session", operation, { method: "DELETE", headers: { "X-DIM-CSRF": session.csrfToken } });
    if (!operations.isCurrent(operation)) return;
    if (result.ok || result.status === 401) showSignedOut();
    else {
      showEvidenceState("error");
      showRequestError("Sign-out could not be completed. Retry before leaving this browser unattended.", () => elements.logoutButton.click(), "Sign-out failed");
      elements.errorTitle.focus();
    }
  } finally {
    if (operations.isCurrent(operation)) endBusy(elements.logoutButton);
  }
});

elements.retryButton.addEventListener("click", () => retryAction?.());

const restoreOperation = startOperation();
request("/v1/session", restoreOperation).then((result) => {
  if (!operations.isCurrent(restoreOperation)) return;
  const activeSession = result.ok ? parseSession(result.body) : null;
  if (activeSession === null) showSignedOut();
  else showWorkspace(activeSession);
}).catch(() => {
  if (operations.isCurrent(restoreOperation)) showSignedOut("The reviewer service could not be reached. Retry when it is available.");
});
