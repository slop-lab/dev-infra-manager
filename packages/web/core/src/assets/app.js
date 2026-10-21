// @ts-check
import { parseSession, record, text } from "./session-data.js";
import { createOperationCoordinator } from "./operation-coordinator.js";
import { clearOperations, showOperations } from "./operations-panel.js";
import { showFeaturePlugins, clearFeaturePlugins } from "./feature-panels.js";

/** @template {typeof HTMLElement} T @param {string} id @param {T} type @returns {InstanceType<T>} */
function element(id, type) {
  const value = document.getElementById(id);
  if (!(value instanceof type)) throw new Error(`Missing console element ${id}`);
  return /** @type {InstanceType<T>} */ (value);
}
const loginForm = element("login-form", HTMLFormElement), username = element("username", HTMLInputElement), password = element("password", HTMLInputElement);
const loginButton = element("login-button", HTMLButtonElement), logoutButton = element("logout-button", HTMLButtonElement);
const loginError = element("login-error", HTMLElement), alerts = element("alert-announcer", HTMLElement), actions = element("session-actions", HTMLElement);
const operations = createOperationCoordinator();
/** @type {import("./types.js").Session | null} */ let session = null;
/** @param {string} path @param {import("./types.js").Operation} operation @param {RequestInit} [options] */
async function request(path, operation, options = {}) {
  try {
    const response = await fetch(path, { ...options, credentials: "same-origin", headers: { accept: "application/json", ...options.headers }, signal: AbortSignal.any([operation.signal, AbortSignal.timeout(10_000)]) });
    /** @type {unknown} */ const body = response.status === 204 ? null : await response.json();
    return { body, status: response.status, ok: response.ok };
  } catch { return { body: null, status: 0, ok: false }; }
}
/** @param {string} [message] */
function signedOut(message = "") {
  operations.start(); session = null; clearOperations(); clearFeaturePlugins();
  element("restore-state", HTMLElement).hidden = true; element("login-view", HTMLElement).hidden = false; actions.hidden = true;
  loginError.textContent = message; alerts.textContent = message;
  const invalid = message.startsWith("Sign-in failed.");
  username.setAttribute("aria-invalid", String(invalid)); password.setAttribute("aria-invalid", String(invalid)); username.focus();
}
/** @param {import("./types.js").Session} active */
function signedIn(active) {
  session = active; password.value = ""; loginError.textContent = ""; alerts.textContent = "";
  element("restore-state", HTMLElement).hidden = true; element("login-view", HTMLElement).hidden = true; actions.hidden = false;
  element("account-label", HTMLElement).textContent = active.roles.join(" · ");
  showOperations(active); void showFeaturePlugins(active);
  if (active.capabilities.operations) element("operations-title", HTMLElement).focus();
}
loginForm.addEventListener("submit", async (event) => {
  event.preventDefault(); if (!loginForm.reportValidity() || loginButton.disabled) return;
  const operation = operations.start(); loginButton.disabled = true; loginButton.classList.add("is-loading"); loginError.textContent = "";
  try {
    const response = await request("/v1/session", operation, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: username.value, password: password.value }) });
    if (!operations.isCurrent(operation)) return;
    const active = response.ok ? parseSession(response.body) : null;
    if (active) return signedIn(active);
    const explanation = text(record(response.body)?.error);
    signedOut(response.status === 403 && explanation?.startsWith("Open this console at ") ? explanation : response.status === 0
      ? "Cannot reach this console. Check your connection and try again."
      : response.status === 429 ? "Sign-in is busy. Wait a moment and try again." : "Sign-in failed. Check your username and password, then try again.");
  } finally { loginButton.disabled = false; loginButton.classList.remove("is-loading"); }
});
logoutButton.addEventListener("click", async () => {
  if (!session || logoutButton.disabled) return;
  const operation = operations.start(); logoutButton.disabled = true;
  try {
    const response = await request("/v1/session", operation, { method: "DELETE", headers: { "x-dim-csrf": session.csrfToken } });
    if (!operations.isCurrent(operation)) return;
    if (response.ok || response.status === 401) signedOut();
    else alerts.textContent = "Sign-out could not be completed. Retry before leaving this browser unattended.";
  } finally { logoutButton.disabled = false; }
});
window.addEventListener("dim-session-expired", () => signedOut("Your session ended. Sign in again."));
const restoring = operations.start();
void request("/v1/session", restoring).then((response) => {
  if (!operations.isCurrent(restoring)) return;
  const active = response.ok ? parseSession(response.body) : null;
  if (active) signedIn(active); else signedOut(response.status === 0 ? "Cannot reach this console. Check your connection and try again." : "");
});
