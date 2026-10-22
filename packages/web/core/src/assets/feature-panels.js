// @ts-check
import { featureUi } from "./feature-ui.js";
/** @typedef {import("./types.js").Session} Session */
/** @typedef {{name:string,description:string,access:string}} Operation */
/** @typedef {{id:string,title:string,description:string,configured:boolean,status:"ready"|"unconfigured"|"unavailable",browserEntry:string,surfaces?:Array<"navigation"|"workspace">,operations:Operation[]}} Feature */
const navigation = document.getElementById("feature-navigation"), tabs = document.getElementById("feature-tabs"), panels = document.getElementById("feature-panels"), base = document.getElementById("feature-workspaces");
if (!(navigation instanceof HTMLElement) || !(tabs instanceof HTMLElement) || !(panels instanceof HTMLElement) || !(base instanceof HTMLButtonElement)) throw new Error("Missing feature navigation");
const nav = navigation, tabList = tabs, panelList = panels, baseButton = base;
let generation = 0;
/** @type {Feature[]} */ let catalog = [];
/** @type {Set<()=>void>} */ const workspaceMounts = new Set();
/** @type {Session | null} */ let session = null;
/** @type {Array<()=>void>} */ const disposers = [];
/** @type {boolean|null} */ let baseState = null;
/** @type {Map<string,{button:HTMLButtonElement,section:HTMLElement,feature:Feature,mounted:boolean,message:HTMLElement,reconnect:HTMLButtonElement}>} */ const views = new Map();
export function clearFeaturePlugins() {
  generation++; session = null; baseState = null; catalog = [];
  for (const refresh of workspaceMounts) refresh();
  for (const dispose of disposers.splice(0)) dispose();
  views.clear(); tabList.replaceChildren(); panelList.replaceChildren(); nav.hidden = true; panelList.hidden = true;
}
/** @param {Session} active */
export async function showFeaturePlugins(active) {
  clearFeaturePlugins(); session = active; const selected = generation;
  try {
    const response = await fetch("/v1/extensions", { credentials: "same-origin", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return;
    /** @type {Feature[]} */ const features = await response.json(); if (selected !== generation) return;
    catalog = features; for (const refresh of workspaceMounts) refresh();
    const navigationFeatures = features.filter((feature) => (feature.surfaces ?? ["navigation"]).includes("navigation"));
    baseButton.textContent = "Workspaces"; baseButton.hidden = !active.capabilities.operations;
    baseButton.setAttribute("aria-pressed", "true");
    for (const feature of navigationFeatures) {
      const button = document.createElement("button"); button.className = "button button-secondary"; button.type = "button"; button.textContent = feature.title; button.setAttribute("aria-pressed", "false");
      const section = document.createElement("section"); section.className = "feature-page"; section.hidden = true;
      const heading = document.createElement("h1"); heading.textContent = feature.title; heading.tabIndex = -1;
      const description = document.createElement("p"); description.className = "operations-intro"; description.textContent = feature.description;
      const connection = document.createElement("div"); connection.className = "feature-connection";
      const reconnect = document.createElement("button"); reconnect.type = "button"; reconnect.className = "button button-secondary"; reconnect.textContent = "Reconnect feature"; reconnect.hidden = !feature.configured;
      const message = document.createElement("p"); message.setAttribute("role", "status"); connection.append(reconnect, message);
      section.append(heading, description, connection); panelList.append(section); tabList.append(button);
      const view = { button, section, feature, mounted: false, message, reconnect }; views.set(feature.id, view);
      reconnect.addEventListener("click", () => { void reconnectFeature(feature.id); });
      button.addEventListener("click", () => { void selectFeature(feature.id); });
    }
    nav.hidden = navigationFeatures.length === 0;
    if (!active.capabilities.operations && navigationFeatures[0]) await selectFeature(navigationFeatures[0].id);
  } catch { /* A missing optional navigation must not prevent base workspace use. */ }
}
/** @param {string|null} id */
async function selectFeature(id) {
  const active = session; if (!active) return;
  const selected = generation;
  const operations = document.getElementById("operations-panel");
  if (!operations) return;
  if (id !== null && baseState === null) baseState = !operations.hidden;
  if (id === null) {
    operations.hidden = !baseState;
    panelList.hidden = true; baseState = null;
  } else { operations.hidden = true; panelList.hidden = false; }
  baseButton.setAttribute("aria-pressed", String(id === null));
  for (const [key, view] of views) { view.section.hidden = key !== id; view.button.setAttribute("aria-pressed", String(key === id)); }
  if (id === null) return;
  const view = views.get(id); if (!view) return;
  view.section.querySelector("h1")?.focus();
  if (view.mounted) return;
  view.mounted = true;
  view.section.querySelector(".feature-load-error")?.remove();
  const content = document.createElement("div"); content.className = "feature-content"; view.section.append(content);
  if (!view.feature.configured) {
    const heading = document.createElement("h2"); heading.textContent = "Connection required";
    const copy = document.createElement("p"); copy.textContent = "This feature is installed. An operator must configure its private server connection before it can be used here.";
    content.className = "feature-content panel feature-empty"; content.append(heading, copy); return;
  }
  if (view.feature.status === "unavailable") {
    const message = document.createElement("p"); message.setAttribute("role", "alert"); message.textContent = "This feature connection is unavailable. Use Reconnect feature to retry; workspaces and other connected features remain available.";
    content.append(message); return;
  }
  if (!view.feature.operations.length) { content.textContent = "This connection does not provide any operations for your account. Ask an operator to check its assigned permissions."; return; }
  try {
    const plugin = await import(view.feature.browserEntry);
    if (selected !== generation) return;
    if (typeof plugin.mount !== "function") throw new Error("Feature UI entrypoint is unavailable");
    const dispose = await plugin.mount(content, {
      operations: view.feature.operations,
      ui: featureUi,
      isCurrent: () => selected === generation,
      invoke: featureInvoker(view.feature, active, () => selected === generation)
    });
    content.dataset.pluginMounted = "true";
    if (typeof dispose === "function") { if (selected === generation) disposers.push(dispose); else dispose(); }
  } catch {
    if (selected !== generation) return;
    content.replaceChildren(); const message = document.createElement("p"); message.className = "feature-load-error"; message.setAttribute("role", "alert"); message.textContent = "This feature could not load. Try opening it again; workspaces remain available.";
    content.append(message); view.mounted = false;
    // The next selection replaces this failed mount without duplicating UI.
    content.remove(); view.section.append(message);
  }
}
/** Reattest the fixed connection without replacing a mounted feature's drafts.
 * @param {string} id
 */
async function reconnectFeature(id) {
  const view = views.get(id), active = session, selected = generation;
  if (!view || !active || view.reconnect.disabled) return;
  view.reconnect.disabled = true; view.message.textContent = "Reconnecting…"; view.message.setAttribute("role", "status");
  try {
    const response = await fetch(`/v1/extensions/${id}/reconnect`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-dim-csrf": active.csrfToken }, body: "{}", signal: AbortSignal.timeout(35_000) });
    if (selected !== generation) return;
    if (response.status === 401) window.dispatchEvent(new Event("dim-session-expired"));
    if (!response.ok) throw new Error("reconnect failed");
    /** @type {Feature} */ const fresh = await response.json();
    if (!fresh || fresh.id !== id) throw new Error("unexpected feature");
    const operations = view.feature.operations; operations.splice(0, operations.length, ...fresh.operations);
    view.feature = { ...fresh, operations };
    if (fresh.status !== "ready") throw new Error("connection unavailable");
    view.message.textContent = "Connection refreshed. Refresh this feature to load current data; your form input is kept.";
    if (!view.section.querySelector('[data-plugin-mounted="true"]')) {
      view.section.querySelector(".feature-content")?.remove(); view.mounted = false; await selectFeature(id);
    }
  } catch {
    if (selected !== generation) return;
    view.message.setAttribute("role", "alert"); view.message.textContent = "Connection is still unavailable. Ask an operator to check its service, credentials and configured scope, then retry.";
  } finally { view.reconnect.disabled = false; }
}
baseButton.addEventListener("click", () => { void selectFeature(null); });

/** @param {Feature} feature @param {Session} active @param {()=>boolean} current */
function featureInvoker(feature, active, current) {
  /** @param {string} name @param {unknown} [input] @param {import("../plugin-api.js").WebPluginInvokeOptions} [options] */
  return async (name, input = {}, options) => {
    const timeout = options === undefined ? 35_000 : options?.timeoutMilliseconds;
    if (options !== undefined && (typeof options !== "object" || options === null || Object.keys(options).some((key) => key !== "timeoutMilliseconds"))
      || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 185_000) throw new Error("Invalid feature request timeout.");
    if (!current() || !feature.operations.some((operation) => operation.name === name)) throw new Error("This operation is not available to this account.");
    let response;
    try {
      response = await fetch(`/v1/extensions/${feature.id}/operations/${encodeURIComponent(name)}`, { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", "x-dim-csrf": active.csrfToken }, body: JSON.stringify(input), signal: AbortSignal.timeout(timeout) });
    } catch (cause) {
      throw Object.assign(new Error("The operation did not return a reliable response, so its outcome is unknown. Refresh current state before retrying.", { cause }), { outcome: "unknown" });
    }
    if (!current()) throw new Error("Your session ended or workspace changed.");
    if (response.status === 401) window.dispatchEvent(new Event("dim-session-expired"));
    if (!response.ok) throw Object.assign(new Error(response.status === 401 ? "Your session ended. Sign in again." : response.status === 403 ? "This account does not have permission for that action." : response.status >= 500 ? "The operation did not return a reliable outcome, so its outcome is unknown. Refresh current state before retrying; your input is kept." : "The connected service rejected this operation. Refresh its state before retrying; your input is kept."), { outcome: response.status >= 500 ? "unknown" : "rejected" });
    try { return await response.json(); }
    catch (cause) { throw Object.assign(new Error("The operation succeeded but its response was unreadable, so its outcome is unknown. Refresh current state before retrying.", { cause }), { outcome: "unknown" }); }
  };
}
/** Mount optional feature-owned controls into one exact workspace row.
 * @param {HTMLElement} container
 * @param {{hostId:string,name:string,id:string,phase:string}} workspace
 * @param {()=>boolean} active
 * @param {()=>Promise<boolean>} refreshWorkspace
 */
export function mountWorkspaceFeatures(container, workspace, active, refreshWorkspace) {
  let revision = 0, disposed = false;
  /** @type {Array<()=>void>} */ let cleanup = [];
  function refresh() {
    const selected = ++revision, currentSession = session;
    /** @type {Map<string,HTMLDetailsElement>} */ const sections = new Map();
    for (const dispose of cleanup) dispose(); cleanup = []; container.replaceChildren();
    if (disposed || !active() || !currentSession) return;
    for (const feature of catalog.filter((entry) => (entry.surfaces ?? ["navigation"]).includes("workspace"))) {
      const details = document.createElement("details"), summary = document.createElement("summary"), content = document.createElement("div");
      summary.textContent = feature.title; details.className = "workspace-feature"; content.className = "feature-form"; details.append(summary, content); container.append(details);
      sections.set(feature.id, details);
      let mounted = false;
      const current = () => !disposed && active() && selected === revision && session === currentSession;
      details.addEventListener("toggle", () => {
        if (!details.open || mounted || !current()) return; mounted = true;
        if (feature.status !== "ready") { content.textContent = "This host feature is unavailable. Ask an operator to check the installed host plugin and reconnect the Web service."; return; }
        if (!feature.operations.length) { content.textContent = "This account has no operations for this feature."; return; }
        void (async () => {
          try {
            const plugin = await import(feature.browserEntry); if (!current()) return;
            if (typeof plugin.mount !== "function") throw new Error("Missing workspace feature entrypoint");
            const dispose = await plugin.mount(content, { workspace, refreshWorkspace, operations: feature.operations, ui: featureUi, isCurrent: current, invoke: featureInvoker(feature, currentSession, current),
              openFeature(/** @type {string} */ id) { const target = sections.get(id); if (!current() || !target) return false; target.open = true; target.querySelector("summary")?.focus(); return true; } });
            if (typeof dispose === "function") { if (current()) cleanup.push(dispose); else dispose(); }
          } catch { if (current()) { mounted = false; content.textContent = "This workspace feature could not load. Close and reopen this section to retry; other workspace controls remain available."; } }
        })();
      });
    }
  }
  workspaceMounts.add(refresh); refresh();
  return () => { disposed = true; revision++; workspaceMounts.delete(refresh); for (const dispose of cleanup) dispose(); cleanup = []; container.replaceChildren(); };
}
