// @ts-check
import { record, text } from "./session-data.js";
import { createWorkspaceHosts } from "./workspace-hosts.js";
import { registerWorkspaceDestination } from "./navigation-broker.js";
import { showWorkspaceView } from "./feature-panels.js";
/** @param {string} id */
function element(id) {
  const value = document.getElementById(id);
  if (!(value instanceof HTMLElement)) throw new Error(`Missing operations element ${id}`);
  return value;
}
const panel = element("operations-panel"), status = element("operations-message"), hosts = element("operations-hosts"), consoles = element("operations-consoles");
/** @type {import("./types.js").Session | null} */ let session = null;
let epoch = 0;
/** @param {string} path @param {unknown} [body] @param {number} [timeout] */
async function request(path, body, timeout = 35_000) {
  const active = session; if (!active) throw new Error("session required");
  let response;
  try {
    response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json", "x-dim-csrf": active.csrfToken }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
  } catch (cause) {
    throw Object.assign(new Error(body === undefined ? "read failed" : "mutation outcome unknown", { cause }), { outcome: body === undefined ? "read" : "unknown" });
  }
  if (response.status === 401) window.dispatchEvent(new Event("dim-session-expired"));
  if (!response.ok) {
    const failure = record(await response.json().catch(() => null));
    throw Object.assign(new Error(response.status === 401 ? "session expired" : "operation failed"), { code: text(failure?.code), outcome: body !== undefined && response.status >= 500 ? "unknown" : "rejected" });
  }
  try { /** @type {unknown} */ const value = await response.json(); return value; }
  catch (cause) { throw Object.assign(new Error("operation response unreadable", { cause }), { outcome: body === undefined ? "read" : "unknown" }); }
}
const workspaceHosts = createWorkspaceHosts(hosts, request, showWorkspaceView);
/** @type {(()=>void)|null} */ let disposeNavigation = null;
export function clearOperations() { session = null; epoch++; disposeNavigation?.(); disposeNavigation = null; panel.hidden = true; workspaceHosts.clear(); consoles.replaceChildren(); }
/** @param {import("./types.js").Session} active */
export function showOperations(active) {
  clearOperations(); session = active; panel.hidden = !active.capabilities.operations;
  if (active.capabilities.operations && active.roles.includes("operator")) disposeNavigation = registerWorkspaceDestination((target) => workspaceHosts.openCreate(target));
  if (active.capabilities.operations) void refresh().catch(() => { status.textContent = "Workspace status could not refresh. Your drafts are kept; retry below."; });
}
/** @param {unknown} value @returns {Record<string,unknown>[]} */
function rows(value) { return Array.isArray(value) ? value.map(record).filter((row) => row !== null) : []; }
async function refresh() {
  const active = session, selected = epoch; if (!active) return;
  status.textContent = "Loading workspaces…";
  const state = record(await request("/v1/operations/status")); if (selected !== epoch) return;
  const hostLoad = workspaceHosts.refresh(rows(state?.hosts).map((host) => text(host.id)).filter((id) => id !== null), active.roles.includes("operator"));
  consoles.replaceChildren();
  for (const console of rows(state?.consoles)) {
    const name = text(console.name), url = text(console.url); if (!name || !url) continue;
    const link = document.createElement("a"); link.textContent = name; link.href = url; link.rel = "noopener noreferrer"; link.target = "_blank"; consoles.append(link);
  }
  const ready = await hostLoad; if (selected !== epoch) return;
  status.textContent = ready ? "Workspaces refreshed." : "Workspace status is shown per host. Your drafts are kept.";
}
element("operations-refresh").addEventListener("click", () => { void refresh().catch(() => { status.textContent = "Workspace refresh failed. Your drafts are kept; try again."; }); });
