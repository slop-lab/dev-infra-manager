// @ts-check
import { record, text } from "./session-data.js";

/** @typedef {(path:string, body?:unknown, timeout?:number)=>Promise<unknown>} Request */
/** @param {string} tag @param {string} [className] @param {string} [content] */
function node(tag, className = "", content = "") {
  const element = document.createElement(tag); element.className = className; element.textContent = content; return element;
}
/** @param {string} label @param {string} [className] */
function button(label, className = "button-secondary") {
  const control = document.createElement("button"); control.type = "button"; control.className = `button ${className}`; control.textContent = label; return control;
}
/** @param {HTMLElement} parent @param {string} name @param {string} label @param {string} scope @param {string} [value] */
function input(parent, name, label, scope, value = "") {
  const field = node("label", "field"), caption = node("span", "", label), control = document.createElement("input");
  control.name = name; control.defaultValue = value; control.setAttribute("aria-label", `${label} ${scope}`);
  field.append(caption, control); parent.append(field); return control;
}
/** @param {HTMLElement} parent @param {string} label */
function disclosure(parent, label) {
  const details = document.createElement("details"), summary = document.createElement("summary"); summary.textContent = label;
  details.append(summary); parent.append(details); return details;
}
/** @param {HTMLElement} target @param {string} message @param {boolean} [error] */
function feedback(target, message, error = false) {
  target.textContent = message; target.className = `workspace-feedback${error ? " is-error" : ""}`;
  target.setAttribute("role", error ? "alert" : "status");
}
/** @param {unknown} error */
function recovery(error) {
  if (error instanceof Error && error.message === "session expired") return "Your session ended. Sign in again; this draft stays here until you leave.";
  return "Refresh the host to check its current state, then retry. Your input is kept.";
}

/** Keep work-in-progress DOM attached while refreshing only server-owned data.
 * @param {HTMLElement} container @param {Request} request
 */
export function createWorkspaceHosts(container, request) {
  let generation = 0;
  /** @type {Map<string,ReturnType<typeof createHost>>} */
  const views = new Map();
  return {
    clear() { generation++; views.clear(); container.replaceChildren(); },
    /** @param {string[]} ids @param {boolean} canOperate */
    async refresh(ids, canOperate) {
      const selected = generation;
      for (const [id, view] of views) if (!ids.includes(id)) { view.section.remove(); views.delete(id); }
      for (const id of ids) if (!views.has(id)) {
        const view = createHost(id, canOperate, request, () => selected === generation);
        views.set(id, view); container.append(view.section);
      }
      if (!ids.length) {
        container.replaceChildren(node("p", "workspace-empty", "No development hosts configured. Add a trusted host to the server operations configuration."));
      } else container.querySelector(":scope > .workspace-empty")?.remove();
      const results = await Promise.all([...views.values()].map((view) => view.refresh()));
      return results.every(Boolean);
    }
  };
}

/** @param {string} id @param {boolean} canOperate @param {Request} request @param {()=>boolean} active */
function createHost(id, canOperate, request, active) {
  const section = node("section", "workspace-host"), heading = node("div", "host-heading"), title = node("div");
  const headingId = `host-${id}`; const h2 = node("h2", "", id); h2.id = headingId; section.setAttribute("aria-labelledby", headingId);
  title.append(node("p", "eyebrow", "Development host"), h2); heading.append(title); section.append(heading);
  const message = node("p", "workspace-feedback"); message.setAttribute("role", "status");
  const retry = button("Retry host"); retry.hidden = true; retry.setAttribute("aria-label", `Retry workspaces on ${id}`);
  const list = node("div", "workspace-list"); list.setAttribute("aria-label", `Workspaces on ${id}`);
  const count = node("p", "host-count", "Loading workspaces…"); title.append(count);
  /** @type {Map<string,ReturnType<typeof createWorkspace>>} */
  const workspaces = new Map();
  let loading = false;
  async function refresh() {
    if (loading) return false;
    loading = true; retry.disabled = true; list.setAttribute("aria-busy", "true");
    feedback(message, workspaces.size ? "Refreshing workspaces…" : "Loading workspaces…");
    try {
      const value = await request(`/v1/operations/hosts/${encodeURIComponent(id)}/workspaces`);
      if (!active()) return false;
      if (!Array.isArray(value)) throw new Error("invalid workspace list");
      const rows = value.map(record).filter((row) => row !== null);
      const ids = new Set(rows.map((row) => text(row.id)));
      for (const [key, view] of workspaces) if (!ids.has(key)) { view.row.remove(); workspaces.delete(key); }
      list.querySelector(".workspace-empty")?.remove();
      for (const workspace of rows) {
        const key = text(workspace.id); if (!key) continue;
        let view = workspaces.get(key);
        if (!view) { view = createWorkspace(id, workspace, canOperate, request, refresh, active); workspaces.set(key, view); list.append(view.row); }
        view.update(workspace);
      }
      count.textContent = `${workspaces.size} workspace${workspaces.size === 1 ? "" : "s"}`;
      if (!workspaces.size) {
        const empty = node("div", "workspace-empty"); empty.append(node("h3", "", "No workspaces yet"), node("p", "", canOperate ? "Choose New workspace to start from a Git repository." : "Workspaces will appear here when an operator creates one.")); list.append(empty);
      }
      feedback(message, ""); retry.hidden = true; return true;
    } catch (error) {
      if (active()) { feedback(message, `Could not load workspaces on ${id}. ${workspaces.size ? "Showing the last loaded state. " : ""}${recovery(error)}`, true); retry.hidden = false; count.textContent = workspaces.size ? `${workspaces.size} workspaces · refresh failed` : "Host unavailable"; }
      return false;
    } finally { loading = false; retry.disabled = false; list.removeAttribute("aria-busy"); }
  }
  if (canOperate) {
    const open = button("New workspace", "button-primary"); open.setAttribute("aria-label", `New workspace on ${id}`); open.setAttribute("aria-expanded", "false");
    const form = createWorkspaceForm(id, request, refresh, active, () => { open.setAttribute("aria-expanded", "false"); open.focus(); });
    form.form.id = `create-workspace-${id}`; open.setAttribute("aria-controls", form.form.id);
    open.addEventListener("click", () => { form.form.hidden = false; open.setAttribute("aria-expanded", "true"); form.source.focus(); });
    heading.append(open); section.append(form.form);
  }
  retry.addEventListener("click", () => { void refresh(); }); section.append(message, retry, list);
  return { section, refresh };
}

/** @param {string} host @param {Request} request @param {()=>Promise<boolean>} refresh @param {()=>boolean} active @param {()=>void} close */
function createWorkspaceForm(host, request, refresh, active, close) {
  const form = document.createElement("form"); form.hidden = true; form.className = "workspace-create panel"; form.setAttribute("aria-label", `New workspace on ${host}`);
  form.append(node("h3", "", "New workspace"), node("p", "field-hint", `Create an isolated development environment on ${host}.`));
  const basic = node("div", "workspace-fields"); form.append(basic);
  const source = input(basic, "source", "Git URL or dim://PROJECT", `on ${host}`); source.type = "url"; source.required = true; source.placeholder = "https://github.com/team/project.git";
  const name = input(basic, "name", "Workspace name", `on ${host}`); name.required = true; name.pattern = "[a-z0-9][a-z0-9._-]{0,47}"; name.placeholder = "my-project"; name.maxLength = 48;
  const advanced = disclosure(form, "Advanced options"); advanced.className = "workspace-advanced";
  const options = node("div", "workspace-fields"); advanced.append(options);
  const ref = input(options, "ref", "Git ref (optional)", `on ${host}`); ref.placeholder = "Repository default";
  const runtime = input(options, "runtime", "Runtime", `on ${host}`, "container"); runtime.required = true; runtime.pattern = "[a-z][a-z0-9-]{0,31}";
  const image = input(options, "image", "Image (optional)", `on ${host}`); image.placeholder = "Host default";
  const repositories = input(options, "repositories", "Managed repositories (comma separated, optional)", `on ${host}`);
  const workingDirectory = input(options, "workingDirectory", "Managed working repository (optional)", `on ${host}`);
  options.append(node("p", "field-hint", "Managed repository selection applies to dim://PROJECT sources."));
  const cpuCount = input(options, "cpuCount", "CPU limit (optional)", `on ${host}`), memory = input(options, "memory", "Memory limit (optional)", `on ${host}`), pidsLimit = input(options, "pidsLimit", "PID limit (optional)", `on ${host}`);
  advanced.append(node("p", "field-hint", "Empty limits use host defaults. Use unlimited to remove a limit."));
  const result = node("p", "workspace-feedback"); result.setAttribute("role", "status");
  const actions = node("div", "workspace-actions"), submit = button("Create workspace", "button-primary"), cancel = button("Cancel"); submit.type = "submit";
  submit.setAttribute("aria-label", `Create workspace on ${host}`); cancel.setAttribute("aria-label", `Cancel new workspace on ${host}`); actions.append(submit, cancel); form.append(result, actions);
  let busy = false;
  cancel.addEventListener("click", () => { form.hidden = true; close(); });
  form.addEventListener("submit", (event) => {
    event.preventDefault(); if (busy || !form.reportValidity()) return;
    const selectedName = name.value.trim();
    /** @type {Record<string,string>} */ const resources = {};
    for (const field of [cpuCount, memory, pidsLimit]) if (field.value.trim()) resources[field.name] = field.value.trim();
    const payload = {
      source: source.value.trim(), name: selectedName, runtime: runtime.value.trim(),
      ...(repositories.value.trim() ? { repositories: repositories.value.split(",").map((id) => id.trim()) } : {}),
      ...(workingDirectory.value.trim() ? { workingDirectory: workingDirectory.value.trim() } : {}),
      ...(ref.value.trim() ? { ref: ref.value.trim() } : {}), ...(image.value.trim() ? { image: image.value.trim() } : {}),
      ...(Object.keys(resources).length ? { resources } : {})
    };
    busy = true; form.setAttribute("aria-busy", "true"); submit.disabled = true; cancel.disabled = true;
    const inputs = [...form.querySelectorAll("input")]; for (const field of inputs) field.disabled = true;
    feedback(result, `Creating ${selectedName} on ${host}… This can take a few minutes.`);
    void (async () => {
      try {
        await request(`/v1/operations/hosts/${encodeURIComponent(host)}/workspaces/create`, payload, 300_000);
        if (!active()) return;
        form.reset(); advanced.open = false;
        const loaded = await refresh();
        feedback(result, `${selectedName} created on ${host}.${loaded ? " The workspace is listed below." : " Refresh the host to see its current state; do not submit it again."}`);
      } catch (error) { if (active()) feedback(result, `Could not create ${selectedName} on ${host}. ${recovery(error)}`, true); }
      finally { busy = false; submit.disabled = false; cancel.disabled = false; for (const field of inputs) field.disabled = false; form.removeAttribute("aria-busy"); }
    })();
  });
  return { form, source };
}

/** @param {string} host @param {Record<string,unknown>} initial @param {boolean} canOperate @param {Request} request @param {()=>Promise<boolean>} refresh @param {()=>boolean} active */
function createWorkspace(host, initial, canOperate, request, refresh, active) {
  let workspace = initial, busy = false;
  const name = text(initial.name) ?? "workspace", expectedId = text(initial.id);
  const row = node("article", "workspace-row"), overview = node("div", "workspace-overview"), identity = node("div", "workspace-identity"), title = node("h3", "", name), badge = node("span", "badge"), meta = node("p", "workspace-meta"), limits = node("p", "workspace-limits");
  identity.append(title, badge); overview.append(identity, meta, limits); row.append(overview);
  const actions = node("div", "workspace-actions"); row.append(actions);
  const result = node("p", "workspace-feedback"); result.setAttribute("role", "status");
  /** @type {Array<{control:HTMLButtonElement, action:string}>} */ const controls = [];
  /** @type {Map<string,HTMLInputElement>} */ const fields = new Map();
  const dirty = new Set();
  /** @param {string} action @param {Record<string,string>} [resources] */
  async function mutate(action, resources) {
    if (busy) return; busy = true; update(workspace);
    feedback(result, `${action === "resources" ? "Updating resources for" : action === "discard" ? "Discarding" : `${action[0]?.toUpperCase()}${action.slice(1)} requested for`} ${name} on ${host}…`);
    try {
      await request(`/v1/operations/hosts/${encodeURIComponent(host)}/workspaces`, { name, expectedId, action, ...(resources ? { resources } : {}) });
      if (!active()) return;
      if (action === "resources") {
        workspace = { ...workspace, resources: { ...record(workspace.resources), ...resources } };
        dirty.clear();
      }
      const loaded = await refresh();
      feedback(result, `${name}: ${action === "resources" ? "resources applied" : `${action} completed`}.${loaded ? "" : " Refresh the host to see its current state."}`);
    } catch (error) { if (active()) feedback(result, `Could not ${action === "resources" ? "update resources for" : action} ${name} on ${host}. ${recovery(error)}`, true); }
    finally { busy = false; update(workspace); }
  }
  /** @param {HTMLElement} parent @param {string} action @param {string} label */
  function actionButton(parent, action, label) {
    const control = button(label); control.setAttribute("aria-label", `${action} ${name}`); controls.push({ control, action });
    control.addEventListener("click", () => { void mutate(action); }); parent.append(control); return control;
  }
  if (canOperate) {
    actionButton(actions, "start", "Start"); actionButton(actions, "stop", "Stop"); actionButton(actions, "restart", "Restart");
    const settings = disclosure(row, `Settings for ${name}`); settings.className = "workspace-settings";
    const form = document.createElement("form"); form.setAttribute("aria-label", `Resources for ${name}`); const grid = node("div", "workspace-fields"); form.append(node("h4", "", "Resource limits"), grid);
    for (const [key, label] of [["cpuCount", "CPUs"], ["memory", "Memory"], ["pidsLimit", "PIDs"]]) {
      if (!key || !label) continue;
      const field = input(grid, key, label, `for ${name}`); field.addEventListener("input", () => dirty.add(key)); fields.set(key, field);
    }
    const apply = button("Apply resources"); apply.type = "submit"; apply.setAttribute("aria-label", `Apply resources for ${name}`); controls.push({ control: apply, action: "resources" }); form.append(apply);
    form.addEventListener("submit", (event) => { event.preventDefault(); if (!form.reportValidity() || !dirty.size) return; void mutate("resources", Object.fromEntries([...fields].filter(([key]) => dirty.has(key)).map(([key, field]) => [key, field.value.trim()]))); });
    settings.append(form);
    const maintenance = node("div", "workspace-maintenance"); maintenance.append(node("p", "field-hint", "Recreate rebuilds the runtime and keeps workspace data.")); actionButton(maintenance, "recreate", "Recreate"); settings.append(maintenance);
    const discard = button("Discard workspace", "button-danger"); discard.setAttribute("aria-label", `discard ${name}`); controls.push({ control: discard, action: "discard" }); settings.append(discard);
    const confirmation = node("div", "workspace-confirmation"); confirmation.hidden = true; confirmation.setAttribute("role", "group"); confirmation.setAttribute("aria-label", `Discard ${name}`);
    confirmation.append(node("h4", "", `Discard ${name}?`), node("p", "", `Permanently delete ${name} on ${host}, including its checkout, home and Docker data. This cannot be undone.`));
    const confirm = button("Discard workspace and data", "button-danger"), keep = button("Keep workspace"); confirm.setAttribute("aria-label", `Discard ${name} and its data`); keep.setAttribute("aria-label", `Keep ${name}`);
    controls.push({ control: confirm, action: "discard" }, { control: keep, action: "discard" }); confirmation.append(confirm, keep); settings.append(confirmation);
    discard.addEventListener("click", () => { confirmation.hidden = false; keep.focus(); });
    keep.addEventListener("click", () => { confirmation.hidden = true; discard.focus(); });
    confirm.addEventListener("click", () => { void mutate("discard"); });
  }
  row.append(result);
  /** @param {Record<string,unknown>} next */
  function update(next) {
    workspace = next; const phase = text(next.phase) ?? "unknown", runtimeStatus = text(next.runtimeStatus) ?? "unknown", resources = record(next.resources);
    badge.textContent = phase; badge.className = `badge ${phase === "running" ? "badge-approved" : phase === "error" ? "badge-error" : phase === "stopped" ? "badge-neutral" : "badge-pending"}`;
    meta.textContent = `${text(next.runtime) ?? "unknown runtime"}${runtimeStatus === phase ? "" : ` · runtime ${runtimeStatus}`}`;
    limits.textContent = `CPU ${text(resources?.cpuCount) ?? "—"} · Memory ${text(resources?.memory) ?? "—"} · PIDs ${text(resources?.pidsLimit) ?? "—"}`;
    for (const [key, field] of fields) { if (!dirty.has(key)) field.value = text(resources?.[key]) ?? ""; field.disabled = busy; }
    const transient = ["creating", "discarding"].includes(phase);
    for (const { control, action } of controls) {
      control.disabled = busy || transient;
      control.hidden = action === "start" ? !(phase === "stopped" || phase === "error" && runtimeStatus !== "running") : ["stop", "restart"].includes(action) ? phase !== "running" && runtimeStatus !== "running" : false;
    }
    row.setAttribute("aria-busy", String(busy));
  }
  return { row, update };
}
