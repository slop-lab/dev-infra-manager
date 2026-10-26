// @ts-check
import { record, text } from "./session-data.js";
import { mountWorkspaceFeatures } from "./workspace-features.js";
import { hrefLocation, readLocation, subscribeLocation } from "./console-location.js";
import { button, disclosure, feedback, input, node, recovery, requiresReconciliation } from "./workspace-ui.js";

/** @typedef {(path:string, body?:unknown, timeout?:number)=>Promise<unknown>} Request */

/** @param {Record<string,unknown>} workspace */
function displayPhase(workspace) {
  const phase = text(workspace.phase) ?? "unknown", runtime = text(workspace.runtimeStatus);
  return ["running", "stopped"].includes(phase) && ["running", "stopped"].includes(runtime ?? "") ? runtime : phase;
}

/** @param {{host:string,initial:Record<string,unknown>,canOperate:boolean,request:Request,refresh:()=>Promise<boolean>,active:()=>boolean}} options */
export function createWorkspace(options) {
  const { host, initial, canOperate, request, refresh, active } = options;
  let workspace = initial, busy = false, reconciliation = false, pendingResources = false, showingStoredFailure = false, disposed = false;
  const name = text(initial.name) ?? "workspace", expectedId = text(initial.id);
  const workspacePath = ["workspaces", host, expectedId ?? ""];
  const row = node("article", "workspace-row workspace-detail"), overview = node("div", "workspace-overview"), identity = node("div", "workspace-identity"), title = node("h2"), titleLink = document.createElement("a"), badge = node("span", "badge"), meta = node("p", "workspace-meta"), limits = node("p", "workspace-limits");
  titleLink.textContent = name; titleLink.href = hrefLocation(workspacePath); title.append(titleLink);
  identity.append(title, badge); overview.append(identity, meta, limits); row.append(overview);
  const listItem = node("article", "workspace-list-item"), listLink = document.createElement("a"), listCopy = node("span", "workspace-list-copy"), listName = node("strong", "", name), listMeta = node("span", "workspace-list-meta"), listBadge = node("span", "badge");
  listLink.href = hrefLocation(workspacePath); listLink.setAttribute("aria-label", `Open ${name} on ${host}`); listCopy.append(listName, listMeta); listLink.append(listCopy, listBadge); listItem.append(listLink);
  const sectionNavigation = node("nav", "workspace-section-navigation"); sectionNavigation.setAttribute("aria-label", `${name} sections`);
  for (const [label, tail] of Object.entries({ Overview: '', Tools: 'tools', Routes: 'routes', Settings: 'settings' })) {
    const link = document.createElement("a"); link.textContent = label; link.href = hrefLocation(tail ? [...workspacePath, tail] : workspacePath); link.dataset.workspaceSection = tail || "overview"; sectionNavigation.append(link);
  }
  row.append(sectionNavigation);
  const actions = node("div", "workspace-actions"), result = node("p", "workspace-feedback");
  row.append(actions);
  /** @type {Array<{control:HTMLButtonElement,action:string}>} */ const controls = [];
  /** @type {Map<string,HTMLInputElement>} */ const fields = new Map();
  const dirty = new Set();
  const check = button("Check current state");
  check.hidden = true;
  check.setAttribute("aria-label", `Check current state for ${name}`);
  actions.append(check);
  const unsaved = node("p", "field-hint", "No unsaved resource changes.");

  function updateUnsaved() { unsaved.textContent = dirty.size ? "Unsaved resource changes." : "No unsaved resource changes."; }
  /** @param {boolean} value */
  function setReconciliation(value) { reconciliation = value; check.hidden = !value; update(workspace); }
  /** @param {string} action @param {Record<string,string>} [resources] */
  async function mutate(action, resources) {
    if (busy || reconciliation) return;
    busy = true; pendingResources = action === "resources"; update(workspace);
    showingStoredFailure = false;
    feedback(result, `${action === "resources" ? "Updating resources for" : action === "discard" ? "Discarding" : `${action.slice(0, 1).toUpperCase()}${action.slice(1)} requested for`} ${name} on ${host}...`);
    try {
      await request(`/v1/operations/hosts/${encodeURIComponent(host)}/workspaces`, { name, expectedId, action, ...(resources ? { resources } : {}) });
      if (!active()) return;
      const loaded = await refresh();
      if (!loaded) { setReconciliation(true); feedback(result, `${name}: the ${action} request was accepted, but current state could not be read. Do not repeat the action. Check current state.`, true); }
      else {
        if (action === "resources") dirty.clear();
        feedback(result, action === "resources" ? `${name}: resource limits refreshed from the host.` : `${name}: current state refreshed after ${action}.`);
        updateUnsaved();
      }
    } catch (error) {
      if (!active()) return;
      if (requiresReconciliation(error)) { setReconciliation(true); feedback(result, `${name}: the ${action} request did not return a reliable outcome, so the outcome is unknown. Do not repeat the action. Check current state.`, true); }
      else feedback(result, `Could not ${action === "resources" ? "update resources for" : action} ${name} on ${host}. ${recovery(error)}`, true);
    } finally { busy = false; update(workspace); }
  }
  /** @param {HTMLElement} parent @param {string} action @param {string} label */
  function actionButton(parent, action, label) {
    const control = button(label);
    control.setAttribute("aria-label", `${action} ${name}`);
    controls.push({ control, action });
    control.addEventListener("click", () => { void mutate(action); });
    parent.append(control);
    return control;
  }
  check.addEventListener("click", () => { void (async () => {
    check.disabled = true;
    feedback(result, `Checking current state for ${name} on ${host}...`);
    const loaded = await refresh();
    if (active() && !disposed) {
      if (loaded) { if (pendingResources) dirty.clear(); setReconciliation(false); update(workspace); updateUnsaved(); feedback(result, `${name}: current state checked. Review it before another action.`); }
      else feedback(result, `${name}: current state could not be checked. Actions remain locked; retry Check current state. Your resource draft is kept.`, true);
    }
    check.disabled = false;
  })(); });
  if (canOperate) {
    actionButton(actions, "start", "Start"); actionButton(actions, "stop", "Stop"); actionButton(actions, "restart", "Restart");
    const settings = disclosure(row, `Settings for ${name}`); settings.className = "workspace-settings"; settings.dataset.workspaceSectionPanel = "settings";
    const form = document.createElement("form"), grid = node("div", "workspace-fields");
    form.setAttribute("aria-label", `Resources for ${name}`);
    form.append(node("h4", "", "Resource limits"), node("p", "field-hint", "Examples: CPUs 2 or 1.5, memory 4g, PIDs 2048. Use unlimited to remove a limit. Removing a limit may require replacing the runtime while keeping workspace data; this console reports only the state returned by the host."), grid);
    /** @type {Array<[string,string]>} */ const resourceFields = [["cpuCount", "CPUs"], ["memory", "Memory"], ["pidsLimit", "PIDs"]];
    for (const [key, label] of resourceFields) {
      const field = input(grid, key, label, `for ${name}`);
      field.addEventListener("input", () => { dirty.add(key); updateUnsaved(); update(workspace); });
      fields.set(key, field);
    }
    const formActions = node("div", "workspace-actions"), apply = button("Apply resources", "button-primary"), reset = button("Reset changes");
    apply.type = "submit";
    apply.setAttribute("aria-label", `Apply resources for ${name}`);
    reset.setAttribute("aria-label", `Reset resource changes for ${name}`);
    controls.push({ control: apply, action: "resources" }, { control: reset, action: "reset" });
    formActions.append(apply, reset); form.append(unsaved, formActions);
    reset.addEventListener("click", () => { dirty.clear(); update(workspace); updateUnsaved(); });
    form.addEventListener("submit", (event) => { event.preventDefault(); if (!form.reportValidity() || !dirty.size) return; void mutate("resources", Object.fromEntries([...fields].filter(([key]) => dirty.has(key)).map(([key, field]) => [key, field.value.trim()]))); });
    settings.append(form);
    const maintenance = node("div", "workspace-maintenance"); maintenance.append(node("p", "field-hint", "Recreate replaces the runtime and keeps checkout, home and nested Docker data.")); actionButton(maintenance, "recreate", "Recreate"); settings.append(maintenance);
    const discard = button("Discard workspace", "button-danger"); discard.setAttribute("aria-label", `discard ${name}`); controls.push({ control: discard, action: "discard" }); settings.append(discard);
    const confirmation = node("div", "workspace-confirmation"); confirmation.hidden = true; confirmation.setAttribute("role", "group"); confirmation.setAttribute("aria-label", `Discard ${name}`);
    confirmation.append(node("h4", "", `Discard ${name}?`), node("p", "", `Permanently delete ${name} on ${host}, including its checkout, home and Docker data. This cannot be undone.`));
    const confirm = button("Discard workspace and data", "button-danger"), keep = button("Keep workspace");
    confirm.setAttribute("aria-label", `Discard ${name} and its data`); keep.setAttribute("aria-label", `Keep ${name}`);
    controls.push({ control: confirm, action: "discard" }, { control: keep, action: "discard" }); confirmation.append(confirm, keep); settings.append(confirmation);
    discard.addEventListener("click", () => { confirmation.hidden = false; keep.focus(); });
    keep.addEventListener("click", () => { confirmation.hidden = true; discard.focus(); });
    confirm.addEventListener("click", () => { void mutate("discard"); });
  }
  row.append(result);
  const features = node("div", "workspace-features"); row.append(features);
  const featureNotice = node('p', 'workspace-feedback'); featureNotice.hidden = true; featureNotice.setAttribute('role', 'status'); row.append(featureNotice);
  /** @type {ReturnType<typeof mountWorkspaceFeatures>|undefined} */ let disposeFeatures;
  const current = () => !disposed && active();
  /** @param {Record<string,unknown>} next */
  function update(next) {
    workspace = next;
    const phase = displayPhase(next) ?? "unknown", runtimeStatus = text(next.runtimeStatus) ?? "unknown", resources = record(next.resources);
    if (!disposeFeatures && expectedId) disposeFeatures = mountWorkspaceFeatures(features, { hostId: host, name, id: expectedId, phase }, current, refresh);
    else disposeFeatures?.update(phase);
    badge.textContent = phase; listBadge.textContent = phase;
    badge.className = `badge ${phase === "running" ? "badge-approved" : phase === "error" ? "badge-error" : phase === "stopped" ? "badge-neutral" : "badge-pending"}`;
    listBadge.className = badge.className;
    meta.textContent = `${text(next.runtime) ?? "unknown runtime"}${runtimeStatus === phase ? "" : ` · runtime ${runtimeStatus}`}`;
    listMeta.textContent = `${host} · ${text(next.runtime) ?? "unknown runtime"}`;
    limits.textContent = `CPU ${text(resources?.cpuCount) ?? "unlimited"} · Memory ${text(resources?.memory) ?? "unlimited"} · PIDs ${text(resources?.pidsLimit) ?? "unlimited"}`;
    if (phase !== "error" && showingStoredFailure) { feedback(result, ""); showingStoredFailure = false; }
    if (phase === "error" && !busy && (!result.textContent || showingStoredFailure)) {
      const reason = recovery(Object.assign(new Error("workspace failed"), { code: text(next.failureCode) }));
      feedback(result, next.initialized === false ? `Initial setup did not finish. ${reason} Ask the operator to inspect it before discard and replacement.` : `Startup failed. ${reason} After fixing host prerequisites, use Start to retry. Recreate keeps workspace data.`, true);
      showingStoredFailure = true;
    }
    for (const [key, field] of fields) { if (!dirty.has(key)) field.value = text(resources?.[key]) ?? "unlimited"; field.disabled = busy || reconciliation; }
    const transient = ["creating", "discarding"].includes(phase);
    for (const { control, action } of controls) {
      control.disabled = busy || reconciliation || transient || action === "resources" && dirty.size === 0 || action === "reset" && dirty.size === 0;
      control.hidden = ["start", "restart", "recreate"].includes(action) && next.initialized === false
        || (action === "start" ? !(phase === "stopped" || phase === "error" && runtimeStatus !== "running") : ["stop", "restart"].includes(action) ? phase !== "running" && runtimeStatus !== "running" : false);
    }
    row.setAttribute("aria-busy", String(busy));
  }
  const applyLocation = (/** @type {string[]} */ path) => {
    const selected = expectedId !== undefined && path[0] === "workspaces" && path[1] === host && path[2] === expectedId;
    row.hidden = !selected;
    listLink.setAttribute("aria-current", selected ? "page" : "false");
    if (!selected) return;
    const section = path[3] ?? "overview";
    for (const link of sectionNavigation.querySelectorAll("a")) link.setAttribute("aria-current", link.dataset.workspaceSection === section ? "page" : "false");
    const settings = row.querySelector(".workspace-settings");
    if (settings instanceof HTMLDetailsElement) settings.open = section === "settings";
    const featureId = section === "tools" ? "agent-tools" : section === "routes" ? "external-urls" : "";
    const missing = featureId && features.dataset.catalogReady === 'true' && !features.querySelector(`[data-feature-id="${featureId}"]`);
    const invalid = path.length > 4 || !['overview', 'tools', 'routes', 'settings'].includes(section);
    featureNotice.hidden = !missing && !invalid;
    featureNotice.textContent = invalid ? 'This workspace task is unavailable. Use Overview or choose one of the listed tasks.' : missing ? `${section === 'tools' ? 'Workspace tools' : 'External routes'} is not installed in this console. Check Settings & access for capabilities and ask the console owner to configure the Web and host plugins.` : '';
    for (const feature of features.querySelectorAll("[data-feature-id]")) {
      if (feature instanceof HTMLDetailsElement) feature.open = featureId !== "" && feature.dataset.featureId === featureId;
    }
  };
  const disposeLocation = subscribeLocation(applyLocation); applyLocation(readLocation());
  const featuresReady = () => applyLocation(readLocation());
  window.addEventListener("dim-workspace-features-ready", featuresReady);
  update(initial); updateUnsaved();
  return { row, listItem, name, id: expectedId ?? "", get phase() { return displayPhase(workspace) ?? "unknown"; }, update, dispose() { disposed = true; disposeLocation(); window.removeEventListener("dim-workspace-features-ready", featuresReady); disposeFeatures?.(); } };
}
