// @ts-check
import { mountAccounts } from "./accounts.js";
import { mountTraffic } from "./traffic.js";
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebPluginBrowserContext} Context */
/** @param {unknown} value @returns {Record<string,unknown>} */
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string,unknown>} */ (value) : {}; }
/** @param {unknown} value */
function rows(value) { return Array.isArray(value) ? value.map(object) : []; }
/** @param {unknown} value */
function text(value) { return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "—"; }
/** @param {HTMLElement} container @param {Context} context */
export function mount(container, context) {
  const { element: node, input } = context.ui;
/** @param {HTMLElement} parent @param {string} label @param {(button:HTMLButtonElement)=>Promise<void>} run @param {HTMLElement} message */
function action(parent, label, run, message) {
  const button = context.ui.button(label);
  button.addEventListener("click", () => { if (button.disabled) return; button.disabled = true; button.dataset.pending = "true"; message.textContent = `${label}…`; message.setAttribute("role", "status");
    void run(button).catch((error) => { message.setAttribute("role", "alert"); message.textContent = error instanceof Error ? error.message : "Operation failed. Refresh before retrying."; }).finally(() => { delete button.dataset.pending; button.disabled = button.dataset.accepted === "true"; }); });
  parent.append(button); return button;
}
/** @param {HTMLElement} parent @param {string[]} headings @param {unknown[][]} values */
function table(parent, headings, values) {
  parent.append(context.ui.table(headings, values.map((cells) => cells.map(text))));
}
  let alive = true, selectedProject = "", projectRevision = "", policyDirty = false, savingPolicy = false, projectLoad = 0, policyEdits = 0, initialLoadFailed = false;
  /** @type {Record<string,unknown>[]} */ let projectRows = [];
  const current = () => alive && context.isCurrent();
  /** @param {string} name */ const has = (name) => context.operations.some((operation) => operation.name === name);
  const toolbar = node("div", "", "feature-actions"), message = node("p"); message.setAttribute("role", "status"); container.append(toolbar, message);
  const overview = node("section", "", "panel"), projects = node("section", "", "panel"), policy = node("section", "", "panel");
  container.append(overview, projects, policy); policy.hidden = true;
  /** @param {HTMLButtonElement} button @param {HTMLElement} feedback @param {string} receipt @param {Array<[string,()=>Promise<unknown>]>} reads */
  async function accepted(button, feedback, receipt, reads) {
    button.dataset.accepted = "true"; feedback.setAttribute("role", "status"); feedback.textContent = receipt;
    const results = await Promise.allSettled(reads.map(([, load]) => load())); if (!current()) return;
    const failed = reads.filter((_, index) => results[index]?.status === "rejected").map(([label]) => label);
    feedback.textContent = failed.length ? `${receipt} Latest ${failed.join(" and ")} could not refresh. Use Refresh router to read the current state; the change was accepted.` : receipt;
  }
  /** @param {HTMLFormElement} form @param {HTMLButtonElement} button */
  function unlockOnEdit(form, button) { form.addEventListener("input", () => { delete button.dataset.accepted; if (button.dataset.pending !== "true") button.disabled = false; }); }
  const projectList = node("div"), projectMessage = node("p"); projectMessage.setAttribute("role", "status");
  projects.append(node("h2", "Projects"), projectList, projectMessage);
  const health = node("div");
  const accountsContainer = node("div"); overview.after(accountsContainer);
  const accountManager = mountAccounts(accountsContainer, context, refresh);
  const trafficManager = mountTraffic(container, context, { current });
  /** @type {HTMLSelectElement|null} */ let routeSelect = null;
  if (has("project.create")) {
    const details = document.createElement("details"), summary = document.createElement("summary"); summary.textContent = "New routing project"; details.append(summary); projects.append(details);
    const form = document.createElement("form"); form.setAttribute("aria-label", "New routing project"); details.append(form);
    const name = input(form, "Project ID"); name.required = true; name.pattern = "[a-z0-9][a-z0-9._-]{0,63}";
    const label = node("label", "Route", "field"), route = document.createElement("select"); route.setAttribute("aria-label", "Project route"); route.required = true; label.append(route); form.append(label); routeSelect = route;
    const submit = action(form, "Create routing project", async (button) => { if (!form.reportValidity()) { projectMessage.textContent = "Complete the project ID and route."; return; }
      const id = name.value.trim(); await context.invoke("project.create", { projectId: id, routeId: route.value }); if (!current()) return;
      name.value = ""; await accepted(button, projectMessage, `${id} created.`, [["project list", refreshProjects], ["project details", () => openProject(id)]]);
    }, projectMessage); submit.className = "button button-primary"; unlockOnEdit(form, submit);
    form.addEventListener("submit", (event) => { event.preventDefault(); submit.click(); });
  }
  async function refreshProjects() {
    projectRows = rows(await context.invoke("projects")); if (!current()) return;
    projectList.replaceChildren();
    if (!projectRows.length) projectList.append(node("p", "No routing projects yet. Create a project to assign routes and admission limits."));
    for (const project of projectRows) {
      const row = node("article", "", "operations-row"), id = text(project.id), actions = node("div", "", "feature-actions");
      row.append(node("h3", id), node("p", `${project.enabled === false ? "Disabled" : project.paused === true ? "Paused" : "Accepting requests"} · Routes: ${Array.isArray(object(project.policy).allowedRoutes) ? object(project.policy).allowedRoutes : "—"}`), actions);
      action(actions, `Open ${id}`, async () => { await openProject(id); }, projectMessage);
      if (has("project.state")) for (const state of project.enabled === false ? ["enable"] : project.paused === true ? ["resume", "disable"] : ["pause", "disable"]) {
        action(actions, `${state[0]?.toUpperCase()}${state.slice(1)} ${id}`, async (button) => {
          if (state === "disable" && !window.confirm(`Disable new requests for ${id}? Existing request outcomes still need inspection.`)) { projectMessage.textContent = "No project state changed."; return; }
          await context.invoke("project.state", { projectId: id, action: state }); if (!current()) return;
          await accepted(button, projectMessage, `${id}: ${state} applied.`, [["project list", refreshProjects]]);
        }, projectMessage);
      }
      projectList.append(row);
    }
  }
  /** @param {string} id @param {()=>boolean} [isCurrent] */
  async function openProject(id, isCurrent = current) {
    if (savingPolicy) { projectMessage.textContent = 'Wait for the current policy save before opening another project.'; return "blocked"; }
    if (policyDirty && !window.confirm(`Discard unsaved policy changes for ${selectedProject} and load ${id}?`)) return "blocked";
    const selectedLoad = ++projectLoad, editsAtLoad = policyEdits;
    const [value, usage] = await Promise.all([context.invoke("project.policy", { projectId: id }), context.invoke("usage", { projectId: id })]);
    if (!current() || !isCurrent() || selectedLoad !== projectLoad) return "blocked";
    if (editsAtLoad !== policyEdits) { projectMessage.textContent = 'Project navigation stopped because the policy changed while loading. Your edits are kept; open the project again when ready.'; return "blocked"; }
    selectedProject = id;
    policyDirty = false;
    const project = object(value), settings = object(project.policy), limits = object(settings.limits), consumption = object(usage), allowance = object(consumption.allowance);
    projectRevision = text(project.revision); policy.hidden = false; policy.replaceChildren(node("h2", `Project ${id}`));
    const stats = node("div"); table(stats, ["Requests", "Known input tokens", "Known output tokens", "Unknown usage", "Occupied slots"], [[consumption.requests, consumption.knownInputTokens, consumption.knownOutputTokens, consumption.unknownUsageRequests, consumption.occupied]]); policy.append(stats);
    policy.append(node("p", `Admission period: ${text(allowance.utcDay)} UTC · ${allowance.remainingRequests === null ? "No limit on requests" : `${text(allowance.remainingRequests)} requests remaining`}. Provider subscription quota is unknown.`, "field-hint"));
    const form = document.createElement("form"); form.setAttribute("aria-label", `Routing policy for ${id}`); policy.append(form);
    let formRevision = 0;
    form.addEventListener("input", () => { policyDirty = true; formRevision++; policyEdits++; });
    const routes = input(form, "Allowed routes (comma separated)", Array.isArray(settings.allowedRoutes) ? settings.allowedRoutes.join(", ") : ""); routes.required = true;
    const fields = node("div", "", "workspace-fields"); form.append(fields);
    /** @type {Map<string,HTMLInputElement>} */ const bounds = new Map();
    for (const [key, label] of [["concurrent", "Concurrent requests"], ["requestsPerUtcDay", "Requests per UTC day"], ["requestBytes", "Maximum request bytes"], ["responseBytes", "Maximum response bytes"], ["captureBytesPerProject", "Capture bytes per project"], ["deadlineMilliseconds", "Request deadline (ms)"]]) {
      if (!key || !label) continue;
      const field = input(fields, label, limits[key] === null ? "" : text(limits[key])); field.type = "number"; field.min = "1"; field.step = "1"; field.placeholder = "No limit";
      bounds.set(key, field);
    }
    form.append(node("p", "Leave limits blank for no limit. Explicit project and service limits both apply.", "field-hint"));
    /** @param {string} label @param {string[]} options @param {unknown} initial */
    function select(label, options, initial) { const field = node("label", label, "field"), control = document.createElement("select"); control.setAttribute("aria-label", label); for (const value of options) { const option = document.createElement("option"); option.value = value; option.textContent = value; control.append(option); } control.value = text(initial); field.append(control); fields.append(field); return control; }
    const captureMode = select("Capture mode", ["required", "best-effort", "metadata"], settings.captureMode), tokenMode = select("Token accounting", ["observe", "estimate"], settings.tokenMode);
    const tokenLimit = input(fields, "Estimated token allowance per UTC day", typeof settings.tokensPerUtcDay === "number" ? String(settings.tokensPerUtcDay) : ""); tokenLimit.type = "number"; tokenLimit.min = "1";
    const estimate = input(fields, "Estimated tokens per request", typeof settings.estimatedTokensPerRequest === "number" ? String(settings.estimatedTokensPerRequest) : ""); estimate.type = "number"; estimate.min = "1";
    form.append(node("p", "Token estimates are admission reservations, not strict provider spending limits. Changing a policy affects subsequent admissions.", "field-hint"));
    const feedback = node("p"); feedback.setAttribute("role", "status"); form.append(feedback);
    if (has("project.policy.update")) {
      let revision = projectRevision;
      const submit = action(form, "Save routing policy", async (button) => {
        if (!form.reportValidity()) { feedback.textContent = "Complete the routing policy fields."; return; }
        const next = { allowedRoutes: routes.value.split(",").map((route) => route.trim()), limits: Object.fromEntries([...bounds].map(([key, field]) => [key, field.value === "" ? null : Number(field.value)])), captureMode: captureMode.value, tokenMode: tokenMode.value,
          ...(tokenLimit.value ? { tokensPerUtcDay: Number(tokenLimit.value) } : {}), ...(estimate.value ? { estimatedTokensPerRequest: Number(estimate.value) } : {}) };
        const submittedRevision = formRevision, savingLoad = ++projectLoad;
        savingPolicy = true;
        try {
          const saved = await context.invoke("project.policy.update", { projectId: id, expectedRevision: revision, policy: next });
          if (!current() || savingLoad !== projectLoad) return;
          policyDirty = submittedRevision !== formRevision; revision = text(object(saved).revision);
          await accepted(button, feedback, `Policy saved for ${id}.`, [["project list", refreshProjects]]);
          if (submittedRevision !== formRevision) delete button.dataset.accepted;
        } finally { savingPolicy = false; }
      }, feedback); submit.className = "button button-primary"; unlockOnEdit(form, submit);
      form.addEventListener("submit", (event) => { event.preventDefault(); submit.click(); });
    } else for (const control of form.querySelectorAll("input,select")) if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) control.disabled = true;
    policy.scrollIntoView({ block: "nearest" });
    return "opened";
  }
  /** @param {boolean} [reconcileUnknown] */
  async function refresh(reconcileUnknown = false) {
    const value = object(await context.invoke("overview")); if (!current()) return;
    initialLoadFailed = false;
    overview.replaceChildren(node("h2", "Accounts & routes"), node("p", `${text(object(value.backend).name)} ${text(object(value.backend).version)} · Provider sign-in is managed by the backend.`));
    table(overview, ["Account", "Configured reference"], rows(value.accounts).map((account) => [account.id, account.reference]));
    table(overview, ["Route", "Account", "Models"], rows(value.routes).map((route) => [route.id, route.accountId, route.models === "all" ? "All models from this account" : rows(route.models).map((model) => `${text(model.id)} (${text(model.api)})`).join(", ")]));
    if (routeSelect) { const selected = routeSelect.value; routeSelect.replaceChildren(); for (const route of rows(value.routes)) { const option = document.createElement("option"); option.value = text(route.id); option.textContent = text(route.id); routeSelect.append(option); } if (rows(value.routes).some((route) => route.id === selected)) routeSelect.value = selected; }
    accountManager.setRoutes(value.routes);
    overview.append(health);
    if (has("health")) action(overview, "Check backend authentication", async () => {
      const result = await context.invoke("health"); if (!current()) return; health.replaceChildren();
      table(health, ["Account", "Authentication", "Observed at"], rows(result).map((account) => [account.accountId, account.backendAuthentication, account.observedAt]));
      message.textContent = "Authentication checked without an inference request. Provider quota remains unknown.";
    }, message);
    const results = await Promise.allSettled([refreshProjects(), trafficManager.refresh(reconcileUnknown), accountManager.refresh()]); if (!current()) return;
    if (results[0]?.status === "rejected") { projectMessage.setAttribute("role", "alert"); projectMessage.textContent = "Project list could not refresh. Previously loaded rows and policy drafts are kept; use Refresh router to retry this read."; }
    message.textContent = results.some((result) => result.status === "rejected" || result.value === false)
      ? "Some router sections could not refresh. Available results are shown below; retry the affected reads with Refresh router."
      : "Router state refreshed. Open a project to inspect usage and policy.";
  }
  action(toolbar, "Refresh router", async () => { await refresh(true); }, message); message.textContent = "Loading router state…";
  const initialLoading = refresh().catch((error) => { initialLoadFailed = true; if (current()) { message.setAttribute("role", "alert"); message.textContent = error instanceof Error ? error.message : "Router unavailable. Check the operator connection and retry."; } });
  const disposeNavigation = context.onNavigate(async (target, isCurrent) => {
    await initialLoading;
    if (!current() || !isCurrent()) return { status: "unavailable", code: "session-ended", message: "This navigation request is no longer current." };
    if (initialLoadFailed) return { status: "unavailable", code: "load-failed", message: "Routing projects could not be loaded." };
    if (target === null || typeof target !== "object" || Array.isArray(target) || Object.keys(target).length !== 2 || !("kind" in target) || !("projectId" in target) || target.kind !== "project" || typeof target.projectId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(target.projectId)) return { status: "unavailable", code: "invalid-target", message: "The routing project target is invalid." };
    const id = target.projectId;
    if (!projectRows.some((project) => project.id === id)) return { status: "unavailable", code: "target-unavailable", message: `Routing project ${id} is not available.` };
    if (selectedProject === id && !policy.hidden) {
      const heading = policy.querySelector("h2"); if (heading instanceof HTMLElement) { heading.tabIndex = -1; heading.focus(); }
      policy.scrollIntoView({ block: "nearest" });
      return { status: "opened", message: `Routing project ${id} is already open.` };
    }
    try { return await openProject(id, isCurrent) === "opened" ? { status: "opened", message: `Opened routing project ${id}.` } : { status: "blocked", message: `Kept unsaved routing policy changes for ${selectedProject}.` }; }
    catch (error) { return { status: "unavailable", code: "load-failed", message: error instanceof Error ? error.message : `Routing project ${id} could not be loaded.` }; }
  });
  return () => { alive = false; disposeNavigation(); trafficManager.dispose(); accountManager.dispose(); };
}
