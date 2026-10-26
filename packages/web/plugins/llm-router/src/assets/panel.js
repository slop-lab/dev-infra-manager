// @ts-check
import { mountRouterControllers } from "./controllers.js"; import { mountAccounts } from "./accounts.js"; import { mountTraffic } from "./traffic.js"; import { mountRouterLocation, routerLink } from "./routes.js"; import { createMutationReconciliation } from "./mutation-reconciliation.js";
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebPluginBrowserContext} Context */
/** @param {unknown} value @returns {Record<string,unknown>} */
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string,unknown>} */ (value) : {}; }
/** @param {unknown} value */
function rows(value) { return Array.isArray(value) ? value.map(object) : []; }
/** @param {unknown} value */
function text(value) { return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "—"; }
/** @param {HTMLElement} container @param {Context} context */
export function mount(container, context) {
  if (!document.querySelector('link[data-llm-router-styles="true"]')) {
    const styles = document.createElement("link"); styles.rel = "stylesheet"; styles.href = new URL("./router.css", import.meta.url).href;
    styles.dataset.llmRouterStyles = "true"; document.head.append(styles);
  }
  return context.operations.some(({ name }) => name === "controllers.list") ? mountRouterControllers(container, context, mountRouter) : mountRouter(container, context);
}
/** @param {HTMLElement} container @param {Context} context */
function mountRouter(container, context) {
  const { element: node, input } = context.ui;
  const workbench = node("div", "", "llm-workbench"), mutations = createMutationReconciliation(); /** @type {Map<string,unknown>} */ const mutationExpectations = new Map(); container.append(workbench);
/** @param {HTMLElement} parent @param {string} label @param {(button:HTMLButtonElement)=>Promise<void>} run @param {HTMLElement} message */
function action(parent, label, run, message) {
  const button = context.ui.button(label);
  button.addEventListener("click", () => { if (button.disabled) return; button.disabled = true; button.dataset.pending = "true"; message.textContent = `${label}…`; message.setAttribute("role", "status");
    void run(button).catch((error) => { const key = button.dataset.mutationKey; if (key && error instanceof Error && "outcome" in error && error.outcome === "unknown") { mutations.unknown(key); button.dataset.accepted = "true"; } message.setAttribute("role", "alert"); message.textContent = error instanceof Error ? error.message : "Operation failed. Refresh before retrying."; }).finally(() => { delete button.dataset.pending; button.disabled = button.dataset.accepted === "true" || Boolean(button.dataset.mutationKey && mutations.locked(button.dataset.mutationKey)); }); });
  parent.append(button); return button;
}
/** @param {HTMLElement} parent @param {string[]} headings @param {unknown[][]} values */
function table(parent, headings, values) {
  parent.append(context.ui.table(headings, values.map((cells) => cells.map(text))));
}
  let alive = true, selectedProject = "", projectRevision = "", policyDirty = false, savingPolicy = false, projectLoad = 0, policyEdits = 0, initialLoadFailed = false;
  /** @type {Set<string>} */ const policyReloadRequired = new Set();
  /** @type {import('./routes.js').RouterRoute} */ let activeRoute = { section: "accounts", objectId: "", valid: true };
  /** @type {Record<string,unknown>[]} */ let projectRows = [];
  const current = () => alive && context.isCurrent();
  /** @param {Event} event */
  const markDraft = (event) => { const target = event.target; const form = target instanceof Element ? target.closest("form") : null; if (form && container.contains(form)) { form.dataset.routerDraft = "true"; for (const button of form.querySelectorAll("button[data-accepted]")) delete /** @type {HTMLButtonElement} */ (button).dataset.accepted; } };
  workbench.addEventListener("input", markDraft); workbench.addEventListener("change", markDraft);
  /** @param {string} name */ const has = (name) => context.operations.some((operation) => operation.name === name);
  const navigation = node("nav", "", "llm-section-nav"); navigation.setAttribute("aria-label", "LLM router tasks");
  const navigationLinks = new Map([
    ["accounts", routerLink(context, "Accounts & routes", ["accounts"], "llm-nav-link", () => applyRoute({ section: "accounts", objectId: "", valid: true }))],
    ["projects", routerLink(context, "Projects & policy", ["projects"], "llm-nav-link", () => applyRoute({ section: "projects", objectId: "", valid: true }))],
    ["traffic", routerLink(context, "Traffic & access", ["traffic"], "llm-nav-link", () => applyRoute({ section: "traffic", objectId: "", valid: true }))]
  ]);
  navigation.append(...navigationLinks.values());
  const toolbar = node("div", "", "feature-actions"), message = node("p"); message.setAttribute("role", "status"); workbench.append(navigation, toolbar, message);
  const overview = node("section", "", "panel"), projects = node("section", "", "panel"), policy = node("section", "", "panel");
  overview.dataset.routerSection = "accounts"; projects.dataset.routerSection = "projects"; policy.dataset.routerSection = "projects";
  workbench.append(overview, projects, policy); policy.hidden = true;
  /** @param {HTMLButtonElement} button @param {HTMLElement} feedback @param {string} receipt @param {Array<[string,()=>Promise<unknown>]>} reads */
  async function accepted(button, feedback, receipt, reads) {
    button.dataset.accepted = "true"; feedback.setAttribute("role", "status"); feedback.textContent = receipt;
    const results = await Promise.allSettled(reads.map(([, load]) => load())); if (!current()) return;
    const failed = reads.filter((_, index) => results[index]?.status === "rejected").map(([label]) => label);
    feedback.textContent = failed.length ? `${receipt} Latest ${failed.join(" and ")} could not refresh. Use Refresh router to read the current state; the change was accepted.` : receipt;
  }
  /** @param {HTMLFormElement} form @param {HTMLButtonElement} button */
  function unlockOnEdit(form, button) { form.addEventListener("input", () => { const key = button.dataset.mutationKey; const policyLocked = Boolean(key?.startsWith('project.policy:') && policyReloadRequired.has(key.slice('project.policy:'.length))); if (key && !policyLocked) mutations.edit(key); if ((!key || mutations.outcome(key) !== "unknown") && !policyLocked) delete button.dataset.accepted; if (button.dataset.pending !== "true") button.disabled = Boolean(key && mutations.locked(key)); }); }
  const projectList = node("div"), projectMessage = node("p"); projectMessage.setAttribute("role", "status");
  const projectHeading = node("div", "", "llm-section-heading");
  const projectHeadingCopy = node("div"); projectHeadingCopy.append(node("h2", "Routing projects"), node("p", "Assign routes, admission limits and capture policy without changing provider credentials.", "llm-section-copy"));
  projectHeading.append(projectHeadingCopy); projects.append(projectHeading, projectList, projectMessage); projectList.className = "llm-object-list";
  const health = node("div");
  const accountsContainer = node("div", "", "llm-account-workspace"); overview.after(accountsContainer);
  const accountManager = mountAccounts(accountsContainer, context, refresh);
  const trafficManager = mountTraffic(workbench, context, { current });
  /** @type {HTMLSelectElement|null} */ let routeSelect = null;
  if (has("project.create")) {
    const details = document.createElement("details"), summary = document.createElement("summary"); summary.textContent = "New routing project"; details.append(summary); projects.append(details);
    const form = document.createElement("form"); form.setAttribute("aria-label", "New routing project"); details.append(form);
    const name = input(form, "Project ID"); name.required = true; name.pattern = "[a-z0-9][a-z0-9._\\-]{0,63}";
    const label = node("label", "Route", "field"), route = document.createElement("select"); route.setAttribute("aria-label", "Project route"); route.required = true; label.append(route); form.append(label); routeSelect = route;
    const submit = action(form, "Create routing project", async (button) => { if (!form.reportValidity()) { projectMessage.textContent = "Complete the project ID and route."; return; }
      const id = name.value.trim(), address = window.location.href, intent = context.location?.revision; button.dataset.mutationKey = `project.create:${id}`; mutationExpectations.set(button.dataset.mutationKey, id); await context.invoke("project.create", { projectId: id, routeId: route.value }); if (!current()) return;
      name.value = '';
      if (address === window.location.href && intent === context.location?.revision) { activeRoute = { section: 'projects', objectId: id, valid: true }; context.location?.navigate(['projects', id]); const destination = window.location.href; await accepted(button, projectMessage, `${id} created.`, [['project list', refreshProjects], ['project details', () => openProject(id, () => destination === window.location.href)]]); }
      else await accepted(button, projectMessage, `${id} created.`, [['project list', refreshProjects]]);
    }, projectMessage); submit.className = "button button-primary"; unlockOnEdit(form, submit);
    form.addEventListener("submit", (event) => { event.preventDefault(); submit.click(); });
  }
  async function refreshProjects() {
    const read = mutations.beginRead(); projectRows = rows(await context.invoke("projects")); if (!current()) return;
    for (const [key, expected] of mutationExpectations) {
      let committed = false;
      if (key.startsWith("project.create:")) committed = projectRows.some((project) => project.id === expected);
      else if (key.startsWith("project.state:")) { const value = object(expected); const project = projectRows.find((row) => row.id === value.id); committed = value.action === "pause" ? project?.paused === true : value.action === "resume" ? project?.paused === false : value.action === "disable" ? project?.enabled === false : project?.enabled !== false; }
      else if (key.startsWith("project.policy:")) { const value = object(expected); committed = JSON.stringify(object(projectRows.find((row) => row.id === value.id)?.policy)) === JSON.stringify(object(value.policy)); }
      const priorOutcome = mutations.outcome(key), outcome = mutations.reconcile(read, key, committed);
      if (key.startsWith('project.policy:') && priorOutcome === 'unknown' && outcome === 'accepted') policyReloadRequired.add(key.slice('project.policy:'.length));
      const control = workbench.querySelector(`button[data-mutation-key="${CSS.escape(key)}"]`); if (control instanceof HTMLButtonElement) { control.disabled = outcome !== undefined; if (outcome === undefined) delete control.dataset.accepted; }
      if (outcome !== "unknown") { mutationExpectations.delete(key); mutationExpectations.delete(`${key}:policy`); }
    }
    projectList.replaceChildren();
    if (!projectRows.length) projectList.append(node("p", "No routing projects yet. Create a project to assign routes and admission limits."));
    for (const project of projectRows) {
      const row = node("article", "", "operations-row"), id = text(project.id), actions = node("div", "", "feature-actions");
      row.dataset.projectId = id;
      const heading = node("h3"), link = routerLink(context, id, ["projects", id], "llm-object-link", () => applyRoute({ section: "projects", objectId: id, valid: true })); heading.append(link);
      row.append(heading, node("p", `${project.enabled === false ? "Disabled" : project.paused === true ? "Paused" : "Accepting requests"} · Routes: ${Array.isArray(object(project.policy).allowedRoutes) ? object(project.policy).allowedRoutes : "—"}`), actions);
      if (has("project.state")) for (const state of project.enabled === false ? ["enable"] : project.paused === true ? ["resume", "disable"] : ["pause", "disable"]) {
        const stateButton = action(actions, `${state[0]?.toUpperCase()}${state.slice(1)} ${id}`, async (button) => {
          if (state === "disable" && !window.confirm(`Disable new requests for ${id}? Existing request outcomes still need inspection.`)) { projectMessage.textContent = "No project state changed."; return; }
          button.dataset.mutationKey = `project.state:${id}:${state}`; mutationExpectations.set(button.dataset.mutationKey, { id, action: state }); await context.invoke("project.state", { projectId: id, action: state }); if (!current()) return;
          await accepted(button, projectMessage, `${id}: ${state} applied.`, [["project list", refreshProjects]]);
        }, projectMessage);
        stateButton.dataset.mutationKey = `project.state:${id}:${state}`; stateButton.disabled = mutations.locked(stateButton.dataset.mutationKey);
        if (stateButton.disabled) actions.append(node('p', 'A previous state change is awaiting reconciliation. Use Refresh router before another change.', 'field-hint'));
      }
      projectList.append(row);
    }
    await applyRoute(activeRoute);
  }
  /** @param {string} id @param {()=>boolean} [isCurrent] @param {boolean} [reloadRevision] */
  async function openProject(id, isCurrent = current, reloadRevision = false) {
    if (savingPolicy) { projectMessage.textContent = 'Wait for the current policy save before opening another project.'; return "blocked"; }
    if (policyDirty && !window.confirm(`Discard unsaved policy changes for ${selectedProject} and load ${id}?`)) return "blocked";
    const selectedLoad = ++projectLoad, editsAtLoad = policyEdits;
    const [value, usage] = await Promise.all([context.invoke("project.policy", { projectId: id }), context.invoke("usage", { projectId: id })]);
    if (!current() || !isCurrent() || selectedLoad !== projectLoad) return "blocked";
    if (editsAtLoad !== policyEdits) { projectMessage.textContent = 'Project navigation stopped because the policy changed while loading. Your edits are kept; open the project again when ready.'; return "blocked"; }
    selectedProject = id;
    policyDirty = false;
    if (reloadRevision) { const key = `project.policy:${id}`; policyReloadRequired.delete(id); mutations.edit(key); mutationExpectations.delete(key); }
    const project = object(value), settings = object(project.policy), limits = object(settings.limits), consumption = object(usage), allowance = object(consumption.allowance);
    projectRevision = text(project.revision); policy.hidden = false; policy.replaceChildren(node("h2", `Project ${id}`));
    action(policy, 'Reload project', async () => { const routeAtStart = activeRoute; await refreshProjects(); if (current() && activeRoute === routeAtStart) await openProject(id, () => activeRoute === routeAtStart, true); }, projectMessage);
    const stats = node("dl", "", "llm-summary-grid");
    for (const [label, value] of Object.entries({ Requests: consumption.requests, 'Known input tokens': consumption.knownInputTokens, 'Known output tokens': consumption.knownOutputTokens, 'Unknown usage': consumption.unknownUsageRequests, 'Occupied slots': consumption.occupied })) {
      const item = node("div"); item.append(node("dt", label), node("dd", text(value))); stats.append(item);
    }
    policy.append(stats);
    policy.append(node("p", `Admission period: ${text(allowance.utcDay)} UTC · ${allowance.remainingRequests === null ? "No limit on requests" : `${text(allowance.remainingRequests)} requests remaining`}. Provider subscription quota is unknown.`, "field-hint"));
    const form = document.createElement("form"); form.setAttribute("aria-label", `Routing policy for ${id}`); policy.append(form);
    let formRevision = 0;
    form.addEventListener("input", () => { policyDirty = true; formRevision++; policyEdits++; });
    const routes = input(form, "Allowed routes (comma separated)", Array.isArray(settings.allowedRoutes) ? settings.allowedRoutes.join(", ") : ""); routes.required = true;
    form.append(node("h3", "Admission limits"));
    const fields = node("div", "", "workspace-fields"); form.append(fields);
    /** @type {Map<string,HTMLInputElement>} */ const bounds = new Map();
    for (const [key, label] of [["concurrent", "Concurrent requests"], ["requestsPerUtcDay", "Requests per UTC day"], ["requestBytes", "Maximum request bytes"], ["responseBytes", "Maximum response bytes"], ["captureBytesPerProject", "Capture bytes per project"], ["deadlineMilliseconds", "Request deadline (ms)"]]) {
      if (!key || !label) continue;
      const field = input(fields, label, limits[key] === null ? "" : text(limits[key])); field.type = "number"; field.min = "1"; field.step = "1"; field.placeholder = "No limit";
      bounds.set(key, field);
    }
    form.append(node("p", "Leave limits blank for no limit. Explicit project and service limits both apply.", "field-hint"));
    form.append(node("h3", "Capture & accounting"));
    const accountingFields = node("div", "", "workspace-fields"); form.append(accountingFields);
    /** @param {HTMLElement} parent @param {string} label @param {string[]} options @param {unknown} initial */
    function select(parent, label, options, initial) { const field = node("label", label, "field"), control = document.createElement("select"); control.setAttribute("aria-label", label); for (const value of options) { const option = document.createElement("option"); option.value = value; option.textContent = value; control.append(option); } control.value = text(initial); field.append(control); parent.append(field); return control; }
    const captureMode = select(accountingFields, "Capture mode", ["required", "best-effort", "metadata"], settings.captureMode), tokenMode = select(accountingFields, "Token accounting", ["observe", "estimate"], settings.tokenMode);
    const tokenLimit = input(accountingFields, "Estimated token allowance per UTC day", typeof settings.tokensPerUtcDay === "number" ? String(settings.tokensPerUtcDay) : ""); tokenLimit.type = "number"; tokenLimit.min = "1";
    const estimate = input(accountingFields, "Estimated tokens per request", typeof settings.estimatedTokensPerRequest === "number" ? String(settings.estimatedTokensPerRequest) : ""); estimate.type = "number"; estimate.min = "1";
    form.append(node("p", "Token estimates are admission reservations, not strict provider spending limits. Changing a policy affects subsequent admissions.", "field-hint"));
    const feedback = node("p"); feedback.setAttribute("role", "status"); form.append(feedback);
    if (has("project.policy.update")) {
      let revision = projectRevision;
      const submit = action(form, "Save routing policy", async (button) => {
        if (!form.reportValidity()) { feedback.textContent = "Complete the routing policy fields."; return; }
        const next = { allowedRoutes: routes.value.split(",").map((route) => route.trim()), limits: Object.fromEntries([...bounds].map(([key, field]) => [key, field.value === "" ? null : Number(field.value)])), captureMode: captureMode.value, tokenMode: tokenMode.value,
          ...(tokenLimit.value ? { tokensPerUtcDay: Number(tokenLimit.value) } : {}), ...(estimate.value ? { estimatedTokensPerRequest: Number(estimate.value) } : {}) };
        const submittedRevision = formRevision, savingLoad = ++projectLoad;
        button.dataset.mutationKey = `project.policy:${id}`; mutationExpectations.set(button.dataset.mutationKey, { id, policy: next });
        savingPolicy = true;
        try {
          const saved = await context.invoke("project.policy.update", { projectId: id, expectedRevision: revision, policy: next });
          if (!current() || savingLoad !== projectLoad) return;
          policyDirty = submittedRevision !== formRevision; revision = text(object(saved).revision);
          mutations.accepted(button.dataset.mutationKey); await accepted(button, feedback, `Policy saved for ${id}.`, [["project list", refreshProjects]]);
           if (submittedRevision !== formRevision) { mutations.edit(button.dataset.mutationKey); delete button.dataset.accepted; }
        } finally { savingPolicy = false; }
      }, feedback); submit.className = "button button-primary"; unlockOnEdit(form, submit);
      submit.dataset.mutationKey = `project.policy:${id}`; submit.disabled = mutations.locked(submit.dataset.mutationKey);
      if (submit.disabled) feedback.textContent = mutations.outcome(submit.dataset.mutationKey) === 'unknown' ? 'A previous policy save has an unknown outcome. Use Refresh router, then Reload project to inspect the current revision before another edit.' : 'A policy save was accepted. Reload project to inspect the current revision before making a separate edit.';
      form.addEventListener("submit", (event) => { event.preventDefault(); submit.click(); });
    } else for (const control of form.querySelectorAll("input,select")) if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) control.disabled = true;
    for (const row of projectList.querySelectorAll("[data-project-id]")) row.classList.toggle("llm-object-selected", row.getAttribute("data-project-id") === id);
    for (const link of projectList.querySelectorAll(".llm-object-link")) if (link instanceof HTMLAnchorElement) link.setAttribute("aria-current", link.textContent === id ? "page" : "false");
    projectMessage.textContent = ""; projectMessage.setAttribute("role", "status");
    policy.scrollIntoView({ block: "nearest" });
    return "opened";
  }
  /** @param {boolean} [reconcileUnknown] */
  async function refresh(reconcileUnknown = false) {
    const accountRead = accountManager.beginOverviewRead(), value = object(await context.invoke("overview")); if (!current()) return;
    initialLoadFailed = false;
    const heading = node("div", "", "llm-section-heading"), headingCopy = node("div");
    headingCopy.append(node("h2", "Accounts & routes"), node("p", "Connect independent provider identities, inspect model catalogs and bind explicit model routes.", "llm-section-copy")); heading.append(headingCopy);
    const accountCount = rows(value.accounts).length, routeCount = rows(value.routes).length;
    overview.replaceChildren(heading, node("p", `${text(object(value.backend).name)} ${text(object(value.backend).version)} · Provider sign-in is managed by the backend.`, "llm-scope"), node("p", `${accountCount} provider account${accountCount === 1 ? "" : "s"} · ${routeCount} route${routeCount === 1 ? "" : "s"} configured.`, "field-hint"));
    if (routeSelect) { const selected = routeSelect.value; routeSelect.replaceChildren(); for (const route of rows(value.routes)) { const option = document.createElement("option"); option.value = text(route.id); option.textContent = text(route.id); routeSelect.append(option); } if (rows(value.routes).some((route) => route.id === selected)) routeSelect.value = selected; }
    accountManager.setRoutes(value.routes, accountRead);
    accountManager.applyRoute(activeRoute);
    overview.append(health);
    if (has("health")) action(overview, "Check backend authentication", async () => {
      const result = await context.invoke("health"); if (!current()) return;
      const details = document.createElement("details"), summary = document.createElement("summary"); summary.textContent = "Authentication check results"; details.open = true; details.append(summary);
      table(details, ["Account", "Authentication", "Observed at"], rows(result).map((account) => [account.accountId, account.backendAuthentication, account.observedAt])); health.replaceChildren(details);
      message.textContent = "Authentication checked without an inference request. Provider quota remains unknown.";
    }, message);
    const results = await Promise.allSettled([refreshProjects(), trafficManager.refresh(reconcileUnknown), accountManager.refresh()]); if (!current()) return;
    if (results[0]?.status === "rejected") { projectMessage.setAttribute("role", "alert"); projectMessage.textContent = "Project list could not refresh. Previously loaded rows and policy drafts are kept; use Refresh router to retry this read."; }
    message.textContent = results.some((result) => result.status === "rejected" || result.value === false)
      ? "Some router sections could not refresh. Available results are shown below; retry the affected reads with Refresh router."
      : "Router state refreshed.";
  }
  action(toolbar, "Refresh router", async () => { await refresh(true); }, message); message.textContent = "Loading router state…";
  /** @param {import('./routes.js').RouterRoute} route */
  async function applyRoute(route) {
    activeRoute = route;
    if (!route.valid && context.location?.path.length) {
      for (const section of workbench.querySelectorAll('[data-router-section]')) if (section instanceof HTMLElement) section.hidden = true;
      for (const link of navigationLinks.values()) link.setAttribute('aria-current', 'false');
      message.dataset.routeError = 'true'; message.setAttribute('role', 'alert'); message.textContent = 'This router task is unavailable. Choose Accounts & routes, Projects & policy or Traffic & access; no alternate object was selected.'; return;
    }
    if (message.dataset.routeError) { delete message.dataset.routeError; message.textContent = ''; message.setAttribute('role', 'status'); }
    for (const [section, link] of navigationLinks) link.setAttribute("aria-current", section === route.section ? "page" : "false");
    for (const section of workbench.querySelectorAll("[data-router-section]")) if (section instanceof HTMLElement) section.hidden = section.dataset.routerSection !== route.section;
    policy.hidden = route.section !== "projects" || route.objectId === "" || route.objectId !== selectedProject;
    accountManager.applyRoute(route);
    trafficManager.applyRoute(route);
    if (route.section === "projects" && route.objectId && projectRows.some((project) => project.id === route.objectId) && selectedProject !== route.objectId) {
      const address = window.location.href;
      const result = await openProject(route.objectId, () => activeRoute === route && address === window.location.href);
      if (activeRoute !== route || address !== window.location.href) return;
      if (result === "blocked" && selectedProject) context.location?.navigate(["projects", selectedProject], { replace: true });
    }
    if (route.section === "projects" && route.objectId && projectRows.length && !projectRows.some((project) => project.id === route.objectId)) {
      projectMessage.setAttribute("role", "alert"); projectMessage.textContent = `Routing project ${route.objectId} is not available on this router.`;
    }
  }
  const disposeLocation = mountRouterLocation(context, applyRoute);
  const initialLoading = refresh().catch((error) => { initialLoadFailed = true; if (current()) { message.setAttribute("role", "alert"); message.textContent = error instanceof Error ? error.message : "Router unavailable. Check the operator connection and retry."; } });
  const disposeNavigation = context.onNavigate(async (target, isCurrent) => {
    const routeAtRequest = activeRoute, addressAtRequest = window.location.href;
    await initialLoading;
    if (!current() || !isCurrent() || activeRoute !== routeAtRequest || addressAtRequest !== window.location.href) return { status: "unavailable", code: "session-ended", message: "This navigation request is no longer current." };
    if (initialLoadFailed) return { status: "unavailable", code: "load-failed", message: "Routing projects could not be loaded." };
    if (target === null || typeof target !== "object" || Array.isArray(target) || Object.keys(target).length !== 2 || !("kind" in target) || !("projectId" in target) || target.kind !== "project" || typeof target.projectId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(target.projectId)) return { status: "unavailable", code: "invalid-target", message: "The routing project target is invalid." };
    const id = target.projectId;
    if (!projectRows.some((project) => project.id === id)) return { status: "unavailable", code: "target-unavailable", message: `Routing project ${id} is not available.` };
    if (selectedProject === id) {
      context.location?.navigate(["projects", id]);
      await applyRoute({ section: "projects", objectId: id, valid: true });
      const heading = policy.querySelector("h2"); if (heading instanceof HTMLElement) { heading.tabIndex = -1; heading.focus(); }
      policy.scrollIntoView({ block: "nearest" });
      return { status: "opened", message: `Routing project ${id} is already open.` };
    }
    try {
      const result = await openProject(id, () => isCurrent() && activeRoute === routeAtRequest && addressAtRequest === window.location.href);
      if (activeRoute !== routeAtRequest || addressAtRequest !== window.location.href) return { status: 'unavailable', code: 'session-ended', message: 'The router navigation request was superseded by another task.' };
      if (result === "opened") context.location?.navigate(["projects", id]);
      return result === "opened" ? { status: "opened", message: `Opened routing project ${id}.` } : { status: "blocked", message: `Kept unsaved routing policy changes for ${selectedProject}.` };
    }
    catch (error) { return { status: "unavailable", code: "load-failed", message: error instanceof Error ? error.message : `Routing project ${id} could not be loaded.` }; }
  });
  const dispose = () => { alive = false; mutations.clear(); workbench.removeEventListener("input", markDraft); workbench.removeEventListener("change", markDraft); disposeLocation(); disposeNavigation(); trafficManager.dispose(); accountManager.dispose(); for (const input of workbench.querySelectorAll('input[type="password"]')) if (input instanceof HTMLInputElement) input.value = ""; workbench.remove(); };
  return Object.assign(dispose, { canLeave: () => !savingPolicy && !policyDirty && accountManager.canLeave() && ![...container.querySelectorAll("form[data-router-draft]")].some((form) => !form.querySelector('button[data-accepted="true"]')), isSaving: () => savingPolicy, hasUnknown: () => mutations.anyUnknown() || accountManager.hasUnknown() || trafficManager.hasUnknown(), hasPending: () => savingPolicy || accountManager.hasPending() || trafficManager.hasPending() || Boolean(workbench.querySelector('button[data-pending="true"]')) });
}
