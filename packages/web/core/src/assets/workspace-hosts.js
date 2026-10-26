// @ts-check
import { record, text } from "./session-data.js";
import { createWorkspaceForm } from "./workspace-create.js";
import { createWorkspace } from "./workspace-row.js";
import { hrefLocation, navigateLocation, readLocation, subscribeLocation } from "./console-location.js";
import { button, feedback, node, recovery } from "./workspace-ui.js";

/** @typedef {(path:string, body?:unknown, timeout?:number)=>Promise<unknown>} Request */

/** @param {HTMLElement} container @param {Request} request @param {()=>void} [reveal] */
export function createWorkspaceHosts(container, request, reveal = () => {}) {
  let generation = 0, catalogReady = false;
  /** @type {Map<string,ReturnType<typeof createHost>>} */ const views = new Map();
  const routeWarning = node('p', 'workspace-feedback'); routeWarning.setAttribute('role', 'alert');
  function checkLocation() {
    const path = readLocation();
    const missingHost = catalogReady && path[0] === 'workspaces' && path[1] && !views.has(path[1]);
    routeWarning.hidden = !missingHost;
    routeWarning.textContent = missingHost ? 'The requested host is not configured in this console. No other host was selected. Choose a configured host below or ask the console owner to check access.' : '';
  }
  subscribeLocation(checkLocation);
  return {
    clear() { generation++; catalogReady = false; for (const view of views.values()) view.dispose(); views.clear(); container.replaceChildren(); },
    /** @param {import("../plugin-api.js").WebManagedWorkspaceCreateTarget} target @returns {import("../plugin-api.js").WebNavigationResult} */
    openCreate(target) {
      const view = views.get(target.hostId);
      if (!view) return { status: "unavailable", code: "target-unavailable", message: `Host ${target.hostId} is not configured for this console.` };
      reveal();
      return view.openCreate(target);
    },
    /** @param {string[]} ids @param {boolean} canOperate */
    async refresh(ids, canOperate) {
      const selected = generation;
      for (const [id, view] of views) if (!ids.includes(id)) { view.dispose(); view.section.remove(); views.delete(id); }
      for (const id of ids) if (!views.has(id)) {
        const view = createHost(id, canOperate, request, () => selected === generation);
        views.set(id, view); container.append(view.section);
      }
      if (!ids.length) container.replaceChildren(node("p", "workspace-empty", "No development hosts configured. Add a trusted host to the server operations configuration."));
      else container.querySelector(":scope > .workspace-empty")?.remove();
      catalogReady = true; container.prepend(routeWarning); checkLocation();
      const results = await Promise.all([...views.values()].map((view) => view.refresh()));
      return results.every(Boolean);
    }
  };
}

/** @param {string} id @param {boolean} canOperate @param {Request} request @param {()=>boolean} active */
function createHost(id, canOperate, request, active) {
  const section = node("section", "workspace-host"), heading = node("div", "host-heading"), title = node("div");
  const headingId = `host-${id}`, h2 = node("h2", "", id), count = node("p", "host-count", "Loading workspaces...");
  h2.id = headingId; section.setAttribute("aria-labelledby", headingId); title.append(node("p", "eyebrow", "Development host"), h2, count); heading.append(title);
  const hostActions = node("div", "workspace-actions"), refreshButton = button("Refresh"), open = document.createElement("a");
  open.className = "button button-primary"; open.textContent = "New workspace"; open.href = hrefLocation(["workspaces", id, "new"]);
  refreshButton.setAttribute("aria-label", `Refresh workspaces on ${id}`); open.setAttribute("aria-label", `New workspace on ${id}`);
  hostActions.append(refreshButton); if (canOperate) hostActions.append(open); heading.append(hostActions); section.append(heading);
  const layout = node("div", "workspace-host-layout"), directory = node("aside", "workspace-directory"), stage = node("div", "workspace-stage");
  directory.setAttribute("aria-label", `Workspace list on ${id}`); stage.setAttribute("aria-label", `Selected workspace on ${id}`); layout.append(directory, stage); section.append(layout);
  const filters = node("div", "workspace-filters"), searchField = node("label", "field"), searchLabel = node("span", "", "Find by name"), search = document.createElement("input");
  search.type = "search"; search.placeholder = "Workspace name"; search.setAttribute("aria-label", `Filter workspaces by name on ${id}`); searchField.append(searchLabel, search);
  const stateField = node("label", "field"), stateLabel = node("span", "", "State"), state = document.createElement("select");
  state.setAttribute("aria-label", `Filter workspaces by state on ${id}`);
  /** @type {Array<[string,string]>} */ const stateOptions = [["all", "All states"], ["running", "Running"], ["stopped", "Stopped"], ["error", "Needs attention"], ["other", "Other states"]];
  for (const [value, label] of stateOptions) { const option = document.createElement("option"); option.value = value; option.textContent = label; state.append(option); }
  stateField.append(stateLabel, state); const clearFilters = button("Clear filters"); clearFilters.setAttribute("aria-label", `Clear workspace filters on ${id}`); filters.append(searchField, stateField, clearFilters); directory.append(filters);
  const message = node("p", "workspace-feedback"), retry = button("Retry host"), list = node("div", "workspace-list"), filterEmpty = node("div", "workspace-empty workspace-filter-empty");
  retry.hidden = true; retry.setAttribute("aria-label", `Retry workspaces on ${id}`); list.setAttribute("aria-label", `Workspaces on ${id}`);
  filterEmpty.hidden = true; filterEmpty.append(node("h3", "", "No workspaces match these filters."), node("p", "", "Clear the filters to show every workspace on this host.")); list.append(filterEmpty);
  /** @type {Map<string,ReturnType<typeof createWorkspace>>} */ const workspaces = new Map();
  let refreshTail = Promise.resolve(true), disposed = false;
  /** @param {string} name */
  const workspaceId = (name) => [...workspaces.values()].find((view) => view.name === name)?.id;
  const form = createWorkspaceForm({ host: id, request, refresh, active, close: () => { navigateLocation(["workspaces"]); open.focus(); }, workspaceId, openWorkspace: (workspaceId) => navigateLocation(["workspaces", id, workspaceId]) });
  form.form.id = `create-workspace-${id}`; if (canOperate) stage.append(form.form);
  const stageEmpty = node("div", "workspace-stage-empty"); stageEmpty.append(node("p", "eyebrow", "Workspace task"), node("h3", "", "Choose a workspace"), node("p", "field-hint", "Open a workspace to manage its runtime, resources, tools and external routes.")); stage.append(stageEmpty);

  function applyFilters() {
    const query = search.value.trim().toLowerCase(), selectedState = state.value;
    let visible = 0;
    for (const view of workspaces.values()) {
      const stateMatches = selectedState === "all" || selectedState === "other" && !["running", "stopped", "error"].includes(view.phase) || view.phase === selectedState;
      view.listItem.hidden = !view.name.toLowerCase().includes(query) || !stateMatches;
      if (!view.listItem.hidden) visible++;
    }
    filterEmpty.hidden = visible !== 0 || workspaces.size === 0;
    clearFilters.disabled = query === "" && selectedState === "all";
    count.textContent = `${visible === workspaces.size ? workspaces.size : `${visible} of ${workspaces.size}`} workspace${workspaces.size === 1 ? "" : "s"}`;
  }
  async function load() {
    if (disposed) return false;
    refreshButton.disabled = true; retry.disabled = true; list.setAttribute("aria-busy", "true");
    feedback(message, workspaces.size ? "Refreshing workspaces..." : "Loading workspaces...");
    try {
      const value = await request(`/v1/operations/hosts/${encodeURIComponent(id)}/workspaces`);
      if (!active() || disposed) return false;
      if (!Array.isArray(value)) throw new Error("invalid workspace list");
      const rows = value.map(record).filter((row) => row !== null), ids = new Set(rows.map((row) => text(row.id)));
      for (const [key, view] of workspaces) if (!ids.has(key)) { view.dispose(); view.row.remove(); view.listItem.remove(); workspaces.delete(key); }
      list.querySelector(":scope > .workspace-empty:not(.workspace-filter-empty)")?.remove();
      for (const workspace of rows) {
        const key = text(workspace.id); if (!key) continue;
        let view = workspaces.get(key);
        if (!view) { view = createWorkspace({ host: id, initial: workspace, canOperate, request, refresh, active }); workspaces.set(key, view); list.append(view.listItem); stage.append(view.row); }
        view.update(workspace);
      }
      if (!workspaces.size) {
        const empty = node("div", "workspace-empty"); empty.append(node("h3", "", "No workspaces yet"), node("p", "", canOperate ? "Choose New workspace to start from a Git repository." : "Workspaces will appear here when an operator creates one.")); list.append(empty);
      }
      feedback(message, ""); retry.hidden = true; applyFilters(); form.setHostReady(true); applyLocation(readLocation()); return true;
    } catch (error) {
      if (active() && !disposed) { form.setHostReady(false); feedback(message, `Could not load workspaces on ${id}. ${workspaces.size ? "Showing the last loaded state. " : ""}${recovery(error)}`, true); retry.hidden = false; count.textContent = workspaces.size ? `${workspaces.size} workspaces · refresh failed` : "Host unavailable"; }
      return false;
    } finally { refreshButton.disabled = false; retry.disabled = false; list.removeAttribute("aria-busy"); }
  }
  function refresh() { const next = refreshTail.then(load, load); refreshTail = next; return next; }
  refreshButton.addEventListener("click", () => { void refresh(); }); retry.addEventListener("click", () => { void refresh(); });
  search.addEventListener("input", applyFilters); state.addEventListener("change", applyFilters); clearFilters.addEventListener("click", () => { search.value = ""; state.value = "all"; applyFilters(); search.focus(); });
  directory.append(message, retry, list);
  const applyLocation = (/** @type {string[]} */ path) => {
    const hostSelected = path[0] === "workspaces" && path[1] === id;
    const creating = hostSelected && path[2] === "new";
    form.form.hidden = !creating;
    if (creating) form.source.focus();
    const selectedId = hostSelected && path[2] !== "new" ? path[2] : undefined;
    const selectedExists = selectedId !== undefined && workspaces.has(selectedId);
    stageEmpty.hidden = creating || selectedExists;
    const emptyTitle = stageEmpty.querySelector("h3");
    if (emptyTitle) emptyTitle.textContent = selectedId && !selectedExists ? "Workspace not found" : "Choose a workspace";
    const copy = stageEmpty.querySelector(".field-hint");
    if (copy) copy.textContent = selectedId && !selectedExists ? "This workspace identity is not available on this host. Return to Workspaces and choose a current object." : "Open a workspace to manage its runtime, resources, tools and external routes.";
  };
  const disposeLocation = subscribeLocation(applyLocation); applyLocation(readLocation());
  return { section, refresh, openCreate(/** @type {import("../plugin-api.js").WebManagedWorkspaceCreateTarget} */ target) { navigateLocation(["workspaces", id, "new"]); return form.prefill(target); }, dispose() { disposed = true; disposeLocation(); for (const view of workspaces.values()) view.dispose(); workspaces.clear(); } };
}
