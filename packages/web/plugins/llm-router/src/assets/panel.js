// @ts-check
/** @typedef {{operations:Array<{name:string,description:string,access:string}>,invoke(name:string,input?:unknown):Promise<unknown>,isCurrent():boolean}} Context */
/** @param {unknown} value @returns {Record<string,unknown>} */
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string,unknown>} */ (value) : {}; }
/** @param {unknown} value */
function rows(value) { return Array.isArray(value) ? value.map(object) : []; }
/** @param {unknown} value */
function text(value) { return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "—"; }
/** @param {string} tag @param {string} [content] @param {string} [className] */
function node(tag, content = "", className = "") { const element = document.createElement(tag); element.textContent = content; element.className = className; return element; }
/** @param {HTMLElement} parent @param {string} label @param {string} [value] */
function input(parent, label, value = "") {
  const field = node("label", "", "field"), control = document.createElement("input"); field.append(node("span", label), control); control.value = value; control.setAttribute("aria-label", label); parent.append(field); return control;
}
/** @param {HTMLElement} parent @param {string} label @param {(button:HTMLButtonElement)=>Promise<void>} run @param {HTMLElement} message */
function action(parent, label, run, message) {
  const button = document.createElement("button"); button.type = "button"; button.className = "button button-secondary"; button.textContent = label;
  button.addEventListener("click", () => { if (button.disabled) return; button.disabled = true; button.dataset.pending = "true"; message.textContent = `${label}…`; message.setAttribute("role", "status");
    void run(button).catch((error) => { message.setAttribute("role", "alert"); message.textContent = error instanceof Error ? error.message : "Operation failed. Refresh before retrying."; }).finally(() => { delete button.dataset.pending; button.disabled = button.dataset.accepted === "true"; }); });
  parent.append(button); return button;
}
/** @param {HTMLElement} parent @param {string[]} headings @param {unknown[][]} values */
function table(parent, headings, values) {
  const wrapper = node("div", "", "feature-table"), result = document.createElement("table"), head = document.createElement("thead"), tr = document.createElement("tr");
  for (const title of headings) { const th = document.createElement("th"); th.scope = "col"; th.textContent = title; tr.append(th); } head.append(tr); result.append(head);
  const body = document.createElement("tbody");
  for (const cells of values) { const row = document.createElement("tr"); for (const value of cells) row.append(node("td", text(value))); body.append(row); }
  result.append(body); wrapper.append(result); parent.append(wrapper);
}
/** @param {HTMLElement} container @param {Context} context */
export function mount(container, context) {
  let alive = true, selectedProject = "", projectRevision = "";
  /** @type {Record<string,unknown>[]} */ let projectRows = [];
  const current = () => alive && context.isCurrent();
  /** @param {string} name */ const has = (name) => context.operations.some((operation) => operation.name === name);
  const toolbar = node("div", "", "feature-actions"), message = node("p"); message.setAttribute("role", "status"); container.append(toolbar, message);
  const overview = node("section", "", "panel"), projects = node("section", "", "panel"), policy = node("section", "", "panel"), traffic = node("section", "", "panel"), principals = node("section", "", "panel");
  container.append(overview, projects, policy, traffic, principals); policy.hidden = true;
  const requestList = node("div"), principalList = node("div"), trafficStatus = node("p"), principalStatus = node("p"), trafficReceipt = node("p"), principalReceipt = node("p");
  traffic.append(node("h2", "Recent requests"), trafficStatus, trafficReceipt, requestList);
  principals.append(node("h2", "Workspace access"), principalStatus, principalReceipt, principalList);
  for (const feedback of [trafficStatus, principalStatus, trafficReceipt, principalReceipt]) feedback.setAttribute("role", "status");
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
      action(actions, `Open ${id}`, () => openProject(id), projectMessage);
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
  /** @param {string} id */
  async function openProject(id) {
    selectedProject = id;
    const [value, usage] = await Promise.all([context.invoke("project.policy", { projectId: id }), context.invoke("usage", { projectId: id })]);
    if (!current() || selectedProject !== id) return;
    const project = object(value), settings = object(project.policy), limits = object(settings.limits), consumption = object(usage), allowance = object(consumption.allowance);
    projectRevision = text(project.revision); policy.hidden = false; policy.replaceChildren(node("h2", `Project ${id}`));
    const stats = node("div"); table(stats, ["Requests", "Known input tokens", "Known output tokens", "Unknown usage", "Occupied slots"], [[consumption.requests, consumption.knownInputTokens, consumption.knownOutputTokens, consumption.unknownUsageRequests, consumption.occupied]]); policy.append(stats);
    policy.append(node("p", `Admission period: ${text(allowance.utcDay)} UTC · ${text(allowance.remainingRequests)} requests remaining. Provider subscription quota is unknown.`, "field-hint"));
    const form = document.createElement("form"); form.setAttribute("aria-label", `Routing policy for ${id}`); policy.append(form);
    const routes = input(form, "Allowed routes (comma separated)", Array.isArray(settings.allowedRoutes) ? settings.allowedRoutes.join(", ") : ""); routes.required = true;
    const fields = node("div", "", "workspace-fields"); form.append(fields);
    /** @type {Map<string,HTMLInputElement>} */ const bounds = new Map();
    for (const [key, label] of [["concurrent", "Concurrent requests"], ["requestsPerUtcDay", "Requests per UTC day"], ["requestBytes", "Maximum request bytes"], ["responseBytes", "Maximum response bytes"], ["captureBytesPerProject", "Capture bytes per project"], ["deadlineMilliseconds", "Request deadline (ms)"]]) {
      if (!key || !label) continue; const field = input(fields, label, text(limits[key])); field.type = "number"; field.min = "1"; field.step = "1"; field.required = true; bounds.set(key, field);
    }
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
        const next = { allowedRoutes: routes.value.split(",").map((route) => route.trim()), limits: Object.fromEntries([...bounds].map(([key, field]) => [key, Number(field.value)])), captureMode: captureMode.value, tokenMode: tokenMode.value,
          ...(tokenLimit.value ? { tokensPerUtcDay: Number(tokenLimit.value) } : {}), ...(estimate.value ? { estimatedTokensPerRequest: Number(estimate.value) } : {}) };
        const saved = await context.invoke("project.policy.update", { projectId: id, expectedRevision: revision, policy: next }); if (!current()) return; revision = text(object(saved).revision); await accepted(button, feedback, `Policy saved for ${id}.`, [["project list", refreshProjects]]);
      }, feedback); submit.className = "button button-primary"; unlockOnEdit(form, submit);
      form.addEventListener("submit", (event) => { event.preventDefault(); submit.click(); });
    } else for (const control of form.querySelectorAll("input,select")) if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) control.disabled = true;
    policy.scrollIntoView({ block: "nearest" });
  }
  async function refreshRequests() {
    const requests = await context.invoke("requests", { limit: 100 }); if (!current()) return;
    requestList.replaceChildren(); trafficStatus.textContent = "";
    const requestRows = rows(requests); if (!requestRows.length) requestList.append(node("p", "No requests recorded yet."));
    for (const request of requestRows) {
      const id = text(request.id), row = node("article", "", "operations-row"), feedback = node("p"); feedback.setAttribute("role", "status");
      row.append(node("h3", `${text(request.project_id)} · ${text(request.model)}`), node("p", `${text(request.outcome)} · Execution ${text(request.execution)} · Usage ${text(request.accounting)}`), node("p", `Request ${id}`, "field-hint"), feedback);
      if (has("request.cancel") && (request.outcome === "running" || request.occupied === 1)) action(row, `Request cancellation ${id.slice(0, 8)}`, async () => { await context.invoke("request.cancel", { requestId: id }); if (current()) feedback.textContent = "Cancellation requested. Upstream termination is not confirmed; inspect the eventual outcome."; }, feedback);
      if (has("request.resolve") && request.execution === "outcome_unknown") action(row, `Resolve unknown outcome ${id.slice(0, 8)}`, async (button) => {
        if (!window.confirm(`Resolve unknown outcome for ${id}? This does not infer token usage or replay inference.`)) { feedback.textContent = "No request was resolved."; return; }
        await context.invoke("request.resolve", { requestId: id }); if (current()) { feedback.textContent = ""; await accepted(button, trafficReceipt, "Resolution recorded; token usage was not supplied.", [["recent requests", refreshRequests]]); }
      }, feedback);
      requestList.append(row);
    }
  }
  async function refreshPrincipals() {
    const credentials = await context.invoke("principals"); if (!current()) return;
    principalList.replaceChildren(); principalStatus.textContent = "";
    const credentialRows = rows(credentials); if (!credentialRows.length) principalList.append(node("p", "No workspace principals issued yet."));
    for (const principal of credentialRows) {
      const row = node("article", "", "operations-row"), feedback = node("p"); feedback.setAttribute("role", "status");
      row.append(node("h3", `${text(principal.workspace_name)} · ${text(principal.project_id)}`), node("p", `Route ${text(principal.route_id)} · ${principal.enabled === 1 ? "Enabled" : "Revoked"}`), feedback);
      if (has("principal.revoke") && principal.enabled === 1) action(row, `Revoke ${text(principal.workspace_name)}`, async (button) => {
        if (!window.confirm(`Revoke ${text(principal.workspace_name)} access to ${text(principal.project_id)}? Reattachment requires host authorization.`)) { feedback.textContent = "No access was revoked."; return; }
        await context.invoke("principal.revoke", { principalId: text(principal.id) }); if (current()) { feedback.textContent = ""; await accepted(button, principalReceipt, `${text(principal.workspace_name)} access revoked.`, [["workspace access", refreshPrincipals]]); }
      }, feedback);
      principalList.append(row);
    }
  }
  async function refreshTraffic() {
    const results = await Promise.allSettled([refreshRequests(), refreshPrincipals()]); if (!current()) return false;
    for (const [index, feedback, label] of /** @type {Array<[number,HTMLElement,string]>} */ ([[0, trafficStatus, "Recent requests"], [1, principalStatus, "Workspace access"]])) {
      if (results[index]?.status === "rejected") { feedback.setAttribute("role", "alert"); feedback.textContent = `${label} could not refresh. Previously loaded rows are kept; use Refresh router to retry this read.`; }
      else feedback.setAttribute("role", "status");
    }
    return results.every((result) => result.status === "fulfilled");
  }
  async function refresh() {
    const value = object(await context.invoke("overview")); if (!current()) return;
    overview.replaceChildren(node("h2", "Accounts & routes"), node("p", `${text(object(value.backend).name)} ${text(object(value.backend).version)} · Provider sign-in is managed by the backend.`));
    table(overview, ["Account", "Configured reference"], rows(value.accounts).map((account) => [account.id, account.reference]));
    table(overview, ["Route", "Account", "Models"], rows(value.routes).map((route) => [route.id, route.accountId, rows(route.models).map((model) => `${text(model.id)} (${text(model.api)})`).join(", ")]));
    if (routeSelect && routeSelect.options.length === 0) for (const route of rows(value.routes)) { const option = document.createElement("option"); option.value = text(route.id); option.textContent = text(route.id); routeSelect.append(option); }
    overview.append(health);
    if (has("health")) action(overview, "Check backend authentication", async () => {
      const result = await context.invoke("health"); if (!current()) return; health.replaceChildren();
      table(health, ["Account", "Authentication", "Observed at"], rows(result).map((account) => [account.accountId, account.backendAuthentication, account.observedAt]));
      message.textContent = "Authentication checked without an inference request. Provider quota remains unknown.";
    }, message);
    const results = await Promise.allSettled([refreshProjects(), refreshTraffic()]); if (!current()) return;
    if (results[0]?.status === "rejected") { projectMessage.setAttribute("role", "alert"); projectMessage.textContent = "Project list could not refresh. Previously loaded rows and policy drafts are kept; use Refresh router to retry this read."; }
    message.textContent = results.some((result) => result.status === "rejected" || result.value === false)
      ? "Some router sections could not refresh. Available results are shown below; retry the affected reads with Refresh router."
      : "Router state refreshed. Open a project to inspect usage and policy.";
  }
  action(toolbar, "Refresh router", refresh, message); message.textContent = "Loading router state…";
  void refresh().catch((error) => { if (current()) { message.setAttribute("role", "alert"); message.textContent = error instanceof Error ? error.message : "Router unavailable. Check the operator connection and retry."; } });
  return () => { alive = false; };
}
