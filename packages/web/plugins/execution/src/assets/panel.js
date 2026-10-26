// @ts-check
import { registerExecutionNavigation } from "./navigation.js";
import { admissionGuidance, completionGuidance } from "./guidance.js";
import { attachExecutionStyles, createExecutionWorkbench, scopedExecutionLocation } from "./workbench.js";
import { createWorkerCapacity } from './capacity.js';
import {createCancellationState} from './cancellation.js';
export { admissionGuidance, completionGuidance } from "./guidance.js";
/** @typedef {{name:string,description:string,access:string}} Descriptor */
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebPluginBrowserContext} Context */
/** @typedef {{id:string,controllerKey?:string,title:string,status:"ready"|"unavailable",operations:Descriptor[]}} Controller */
/** @typedef {import('@slop-lab/dim-contracts-ci/query').ExecutionSummary} Job */
/** @typedef {{kind:'repository-jobs',controllerKey:string,projectId:string,repositoryId:string}|{kind:'job',controllerKey:string,jobId:string}} NavigationTarget */
/** @param {HTMLElement} container @param {Context} context */
export function mount(container, context) {
  const disposeStyles = attachExecutionStyles();
  let disposed = false, scopeVersion = 0, discoveryVersion = 0;
  /** @type {Map<string,string>} */ const retryRequests = new Map();
  const cancellations = createCancellationState();
  /** @type {string|undefined} */ let selectedController;
  /** @type {Controller[]} */ let controllers = [];
  /** @type {HTMLSelectElement|undefined} */ let controllerSelect;
  /** @type {{applyNavigation(target:NavigationTarget,values:Job[],isCurrent:()=>boolean):Promise<boolean>,disposeLocation?:()=>void}|undefined} */ let activePanel;
  const { ui } = context, current = () => !disposed && context.isCurrent();
  /** @param {string} name */ const advertised = (name) => context.operations.some((operation) => operation.name === name);
  const discovery = ui.element("div"), content = ui.element("div", "", "execution-workbench");
  container.append(discovery, content);

  /** @param {Controller|undefined} controller @param {readonly Descriptor[]} operations */
  function render(controller, operations) {
    const controllerId = controller?.id, controllerKey = controller?.controllerKey;
    const version = ++scopeVersion;
    let detailVersion = 0, jobsVersion = 0;
    let activeDetail = "";
    /** @type {{projectId:string,repositoryId:string}|undefined} */ let repositoryTarget;
    /** @type {Job[]} */ let loadedJobs = [];
    const scoped = () => current() && version === scopeVersion;
    /** @param {string} name */ const connectionAllows = (name) => operations.some((operation) => operation.name === name);
    /** @param {string} name */ const allowed = (name) => connectionAllows(name) && advertised(name);
    /** @param {'jobs.cancel'|'jobs.retry'} operation @param {'Cancel'|'Retry'} label */
    function authorityGuidance(operation, label) { const browserAllows = advertised(operation), serviceAllows = connectionAllows(operation);
      const reason = browserAllows ? `This browser account has the operator role, but the selected service connection is not operator-enabled.` : serviceAllows ? `The selected service connection is operator-enabled, but this browser account does not have the operator role.` : `This browser account does not have the operator role, and the selected service connection is not operator-enabled.`, note = ui.element('p', `${label} is unavailable. It requires both the browser operator role and an operator-enabled service connection. ${reason}`, 'field-hint');
      note.dataset.executionAuthority = operation === 'jobs.cancel' ? 'cancel' : 'retry'; return note;
    }
    const invoke = (/** @type {string} */ name, /** @type {Record<string,unknown>} */ input) => {
      if (!scoped()) return Promise.reject(new Error("Controller selection changed"));
      return context.invoke(name, controllerId === undefined ? input : { ...input, controllerId });
    };
    content.replaceChildren();
    const routeKey = controllerKey ?? controllerId;
    const location = scopedExecutionLocation(context.location, routeKey ? ["controllers", routeKey] : []);
    const { root, toolbar, status, filterContext, jobs, detail, capacity, search, state, paintSection } = createExecutionWorkbench(ui, location);
    content.append(...root);
    const paintLocation = (/** @type {readonly string[]} */ path) => paintSection(path.length === 0 || path[0] === 'jobs' && path.length <= 2 || ['workers','launch'].includes(path[0] ?? '') && path.length === 1 ? path[0] ?? 'jobs' : 'unavailable');
    paintLocation(location?.path ?? []);
    const disposeLocation = location?.subscribe((path) => {
      if (!scoped()) return;
      ++detailVersion;
      paintLocation(path);
      const job = path[0] === "jobs" && path.length === 2 ? loadedJobs.find(({ id }) => id === path[1]) : undefined;
      if (!job) { activeDetail = ''; detail.replaceChildren(); }
      if (job && activeDetail !== job.id) openSafely(job);
    });

    /** @param {HTMLElement} parent @param {string} label @param {(button:HTMLButtonElement)=>Promise<boolean|void>} action @param {"lock"|"reuse"|undefined} [unknownPolicy] */
    function actionButton(parent, label, action, unknownPolicy) {
      const node = ui.button(label);
      if (unknownPolicy) node.dataset.unknownPolicy = unknownPolicy;
      node.addEventListener("click", async () => {
        if (!scoped() || node.disabled) return;
        node.disabled = true; ui.feedback(status, `${label}…`);
        try { const result = await action(node); if (scoped() && result !== false) ui.feedback(status, `${label} completed.`); }
        catch (error) {
          if (!scoped()) return;
          const unknown = error instanceof Error && "outcome" in error && error.outcome === "unknown";
          if (unknown && unknownPolicy === "lock") { node.dataset.accepted = 'true'; if (node.dataset.cancelKey) cancellations.unknown(node.dataset.cancelKey); }
          ui.feedback(status, unknown && unknownPolicy === "lock"
            ? `${label}: outcome is unknown. Repeat cancellation is locked until Refresh jobs reads authoritative queue state.`
            : `${label} failed: ${error instanceof Error ? error.message : "service unavailable"}. ${unknownPolicy === "reuse" ? "Retry reuses the same request ID, or refresh jobs to inspect current state." : "Retry when the service is available."}`, "error");
        }
        finally { if (scoped()) node.disabled = node.dataset.accepted === "true"; }
      });
      parent.append(node); return node;
    }
    /** @param {HTMLButtonElement} button @param {string} receipt @param {Array<[string,()=>Promise<unknown>]>} reads */
    async function accepted(button, receipt, reads) {
      if (!scoped()) return false;
      button.dataset.accepted = "true"; ui.feedback(status, receipt);
      const results = await Promise.allSettled(reads.map(([, read]) => read()));
      if (scoped()) {
        const failed = reads.filter((_, index) => results[index]?.status === "rejected").map(([name]) => name);
        ui.feedback(status, failed.length ? `${receipt} Latest ${failed.join(" and ")} could not refresh. Refresh this view to inspect current state; the action was accepted.` : receipt, failed.length ? "error" : "status");
      }
      return false;
    }
    function paintJobs() {
      const query = search.value.trim().toLowerCase(), phase = state.value;
      const visible = loadedJobs.filter((job) => (!repositoryTarget || job.projectId === repositoryTarget.projectId && job.repositoryId === repositoryTarget.repositoryId)
        && (!phase || job.phase === phase) && (!query || [job.id, job.jobName, job.projectId, job.repositoryId].some((value) => value.toLowerCase().includes(query))));
      jobs.replaceChildren(ui.element("h3", "Recent jobs"));
      if (!loadedJobs.length) { jobs.append(ui.element("p", "No recent jobs.")); return; }
      if (!visible.length) { jobs.append(ui.element("p", "No jobs match the current search and state filter.")); return; }
      const table = ui.table(["Job", "Repository", "State", "Created", "Details"], visible.map((job) => ["", `${job.projectId}/${job.repositoryId}`, `${job.phase}${job.outcome ? ` / ${job.outcome}` : ""}`, new Date(job.createdAt).toLocaleString(), ""]));
      const rows = table.querySelectorAll("tbody tr");
      visible.forEach((job, index) => {
        const row = rows[index], name = row?.firstElementChild, cell = row?.lastElementChild;
        const labels = ["Job", "Repository", "State", "Created", "Details"];
        for (const [cellIndex, tableCell] of [...(row?.children ?? [])].entries()) if (tableCell instanceof HTMLElement) tableCell.dataset.label = labels[cellIndex] ?? "";
        if (name instanceof HTMLElement) {
          const link = ui.element("a", job.jobName, "execution-job-link"); link.href = location?.href(["jobs", job.id]) ?? `#execution-job-${job.id}`;
          link.addEventListener("click", (event) => {
            if (location && event instanceof MouseEvent && (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)) return;
            event.preventDefault(); openSafely(job);
          });
          name.replaceChildren(link);
        }
        if (cell instanceof HTMLElement) actionButton(cell, "View job", () => open(job));
      });
      jobs.append(table);
    }
    /** @param {Job} job */
    function openSafely(job) { void open(job).catch((error) => { if (scoped()) ui.feedback(status, `Job details could not load. ${error instanceof Error ? error.message : 'Refresh jobs to retry.'}`, 'error'); }); }
    /** @param {Job} job @param {()=>boolean} [isCurrent] */
    async function open(job, isCurrent = scoped) {
      const request = ++detailVersion, address = window.location.href;
      const value = /** @type {import('zod').infer<typeof import('@slop-lab/dim-contracts-ci/query').executionDetailSchema>} */ (await invoke("jobs.detail", { id: job.id }));
      if (!scoped() || !isCurrent() || request !== detailVersion || address !== window.location.href) return false;
      activeDetail = value.job.id;
      const header = ui.element("div", "", "execution-detail-header"), title = ui.element("div"); title.append(ui.element("p", "Selected job", "eyebrow"), ui.element("h3", `${value.job.jobName} — ${value.job.phase}`)); header.append(title);
      const metadata = ui.element("dl", "", "execution-summary-grid"); for (const [label, text] of [["Job ID", value.job.id], ["Controller", controller?.title ?? "Direct connection"], ["Project / repository", `${value.job.projectId} / ${value.job.repositoryId}`], ["Worker / slot", `${value.job.workerId ?? "unassigned"} / ${value.job.slotId ?? "unassigned"}`], ["Outcome", value.job.outcome ?? "pending"], ["Publication", value.job.publication]]) { const item = ui.element("div"); item.append(ui.element("dt", label), ui.element("dd", text)); metadata.append(item); }
      detail.replaceChildren(ui.element("p", "Selected job details are retained independently of list filters.", "field-hint"), header, metadata);
      if (value.job.cancelRequestedAt !== undefined) detail.append(ui.element('p', value.job.phase === 'finished' ? 'Cancellation was recorded. Inspect the final completion below.' : 'Cancellation is recorded. Worker termination is not yet confirmed; inspect the eventual completion.', 'field-hint'));
      detail.append(ui.element("h4", "Results"));
      if (!value.result) detail.append(ui.element("p", "No result payload is available from the execution query contract for this job.", "field-hint"));
      if (value.job.admission) detail.append(ui.element("h4", "Admission guidance"), ui.element("p", admissionGuidance(value.job.admission), "field-hint"));
      if (value.job.completion) detail.append(ui.element("h4", "Completion"), ui.element("p", completionGuidance(value.job.completion), "field-hint"));
      const logs = ui.element("div", "", "execution-log-grid"); detail.append(ui.element("h4", "Logs"), logs);
      if (value.result) {
        for (const stream of ["stdout", "stderr"]) {
          const log = stream === "stdout" ? value.result.logs.stdout : value.result.logs.stderr;
          let text;
          try { text = new TextDecoder().decode(Uint8Array.from(atob(log.base64), (char) => char.charCodeAt(0))); }
          catch { text = "Captured log could not be decoded."; }
          const panel = ui.element("section"); panel.append(ui.element("h5", `${stream}${log.truncated ? " (truncated by execution service)" : ""}`), ui.element("pre", text || "No captured output.", "log-output")); logs.append(panel);
        }
      } else logs.append(ui.element("p", value.job.phase === "finished" ? "This job finished without a guest result or captured logs. Use its completion and admission guidance to distinguish infrastructure failure, cancellation, timeout or output-limit termination." : "Logs become available after this job completes."));
      detail.append(ui.element("h4", "Artifacts"), ui.element("p", "This execution contract does not expose downloadable artifacts. Artifact ownership remains with the task producer or CI integration that submitted the work.", "field-hint"));
      if (value.job.phase === "queued") detail.append(ui.element("p", `Waiting for an active worker with a matching ${value.job.executionKind} slot. Inspect Worker capacity below; configured idle slots do not prove the worker process is running.`, "field-hint"));
      const cancellable = value.job.cancelRequestedAt === undefined && ["queued", "assigned", "running", "recovering"].includes(value.job.phase);
      if (cancellable && !allowed('jobs.cancel')) detail.append(authorityGuidance('jobs.cancel', 'Cancel'));
      if (cancellable && allowed('jobs.cancel')) { const key = `${controllerId ?? 'direct'}/${value.job.id}`; const cancel = actionButton(detail, "Cancel execution", async (button) => {
          if (!window.confirm(`Cancel ${value.job.jobName} (${value.job.id})?`)) { ui.feedback(status, "Cancellation dismissed."); return false; } await invoke("jobs.cancel", { id: value.job.id }); cancellations.accepted(key); return accepted(button, "Cancellation accepted.", [["job list and details", refreshJobs]]);
      }, "lock"); cancel.dataset.cancelKey = key; cancel.disabled = cancellations.locked(key); if (cancel.disabled) detail.append(ui.element('p', cancellations.outcome(key) === 'unknown' ? 'Cancellation outcome is unknown. Use Refresh jobs to inspect authoritative state before another action.' : 'Cancellation was accepted or already observed. Use Refresh jobs to inspect current state.', 'field-hint')); }
      if (value.job.phase === "finished" && !allowed('jobs.retry')) detail.append(authorityGuidance('jobs.retry', 'Retry'));
      if (value.job.phase === "finished" && allowed('jobs.retry')) actionButton(detail, "Retry execution", async (button) => {
          const key = `${controllerId ?? "direct"}/${value.job.id}`; let requestId = retryRequests.get(key); if (!requestId) { requestId = crypto.randomUUID(); retryRequests.set(key, requestId); }
          await invoke("jobs.retry", { id: value.job.id, requestId }); return accepted(button, "Retry execution accepted.", [["job list", refreshJobs]]);
      }, "reuse");
      if (controllerKey && context.navigation.hasFeature("native-git")) context.ui.navigationAction(detail, {
        label: "Open repository reviews", status, isCurrent: () => scoped() && activeDetail === value.job.id,
        open: () => context.navigation.openFeature("native-git", { kind: "repository", controllerKey, projectId: value.job.projectId, repositoryId: value.job.repositoryId })
      });
      paintSection("jobs");
      if (location) location.navigate(["jobs", value.job.id]);
      return true;
    }
    async function refreshJobs() {
      const request = ++jobsVersion, read = cancellations.beginRead(), values = /** @type {Job[]} */ (await invoke("jobs.list", {}));
      if (!scoped() || request !== jobsVersion) return;
      loadedJobs = values; paintJobs();
      for (const job of values) cancellations.reconcile(`${controllerId ?? 'direct'}/${job.id}`,read,job);
      const path = location?.path, job = path?.[0] === 'jobs' && path.length === 2 ? values.find(({id})=>id===path[1]) : undefined;
      if (job) { const key = `${controllerId ?? 'direct'}/${job.id}`; if (cancellations.outcome(key) === 'unknown' && !cancellations.fresh(key,read)) { ui.feedback(status,'An older job read did not reconcile the newer unknown cancellation. Use Refresh jobs again.','error'); return false; } return open(job); }
      if (path?.[0] === 'jobs' && path.length === 2) ui.feedback(status,'The requested execution job is not in the current controller catalog. Choose a listed job or refresh the queue.','error');
    }
    const refreshCapacity = createWorkerCapacity(capacity, {ui, invoke, isCurrent: scoped, openJob(parent, job) { if (allowed('jobs.detail')) actionButton(parent, 'View worker job', () => open(job)); else parent.append(ui.element('p', 'Job details require read access.')); }});
    search.addEventListener("input", paintJobs); state.addEventListener("change", paintJobs);
    if (allowed("jobs.list")) actionButton(toolbar, "Refresh jobs", refreshJobs);
    else jobs.append(ui.element('h3', 'Job query access required'), ui.element('p', 'Job queries require read access on this browser account and service connection. Worker-management authority does not grant job-query authority.'));
    if (allowed("workers.list")) { actionButton(toolbar, "Refresh worker capacity", refreshCapacity); void refreshCapacity(); }
    else capacity.append(ui.element('h3', 'Capacity access required'), ui.element('p', 'Worker capacity requires operator access on both this browser account and the selected service connection. Ask the console owner to check access; job queries remain available.'));
    const jobsReady = allowed("jobs.list") ? refreshJobs() : Promise.resolve();
    void jobsReady.catch((error) => { if (scoped()) ui.feedback(status, `Could not load jobs: ${error instanceof Error ? error.message : "service unavailable"}. Use Refresh jobs to retry.`, "error"); });
    /** @param {NavigationTarget} target @param {Job[]} values @param {()=>boolean} isCurrent */
    async function applyNavigation(target, values, isCurrent) {
      if (!scoped() || !isCurrent()) return false;
      const job = target.kind === "job" ? values.find(({ id }) => id === target.jobId) : undefined;
      if (target.kind === "job" ? !job : !values.some(({ projectId, repositoryId }) => projectId === target.projectId && repositoryId === target.repositoryId)) return false;
      ++jobsVersion;
      loadedJobs = values; paintJobs();
      if (target.kind === "job") return job ? open(job, isCurrent) : false;
      repositoryTarget = { projectId: target.projectId, repositoryId: target.repositoryId }; search.value = ""; state.value = "";
      filterContext.replaceChildren(ui.element("p", `Showing jobs for ${target.projectId}/${target.repositoryId}.`, "workspace-feedback"));
      const clear = ui.button("Clear repository filter", "secondary"); clear.addEventListener("click", () => { repositoryTarget = undefined; filterContext.replaceChildren(); paintJobs(); }); filterContext.append(clear);
      paintJobs(); location?.navigate(['jobs']); return true;
    }
    return { applyNavigation, ...(disposeLocation ? { disposeLocation } : {}) };
  }

  /** @param {Controller|undefined} controller */
  function choose(controller) {
    activePanel?.disposeLocation?.();
    selectedController = controller?.id;
    if (controllerSelect) controllerSelect.value = controller?.id ?? '';
    const copy = discovery.querySelector('.execution-provenance-copy'); copy?.replaceChildren(ui.element('p', 'Service provenance', 'eyebrow'), ui.element('p', controller?.controllerKey ? `${controller.title} is discovered through trusted controller ${controller.controllerKey}. Operations remain pinned to its attested service generation.` : 'No alternate execution authority was selected.'));
    if (!controller || controller.status !== "ready") { ++scopeVersion; activePanel = undefined; content.replaceChildren(ui.element("p", controller ? "Execution is unavailable on this controller. Refresh controllers after connecting its execution service." : "The requested execution controller is unavailable or not configured. Select a configured controller explicitly; no other service was selected.")); return; }
    activePanel = render(controller, controller.operations);
  }

  async function discover() {
    const request = ++discoveryVersion; ++scopeVersion; activePanel?.disposeLocation?.(); activePanel = undefined;
    for (const select of discovery.querySelectorAll("select")) select.disabled = true;
    content.replaceChildren(ui.element("p", "Discovering execution services…"));
    try {
      const value = /** @type {{controllers:Controller[]}} */ (await context.invoke("controllers.list", {}));
      if (!current() || request !== discoveryVersion) return;
      controllers = value.controllers;
      const provenance = ui.element("div", "", "execution-provenance"), selector = ui.element("div"), provenanceCopy = ui.element("div", "", "execution-provenance-copy");
      discovery.replaceChildren(provenance); provenance.append(selector, provenanceCopy);
      const select = ui.select(selector, "Controller", value.controllers.map((controller) => ({ value: controller.id, label: `${controller.title}${controller.status === "unavailable" ? " (unavailable)" : ""}` })));
      controllerSelect = select;
      const refresh = ui.button("Refresh controllers"); refresh.addEventListener("click", () => { void discover(); }); selector.append(refresh);
      const path = context.location?.path ?? [];
      const selected = path.length ? path[0] === 'controllers' ? value.controllers.find(({ controllerKey, id }) => (controllerKey ?? id) === path[1]) : undefined : value.controllers.find(({ id }) => id === selectedController) ?? value.controllers.find(({ status }) => status === "ready") ?? value.controllers[0];
      if (selected) select.value = selected.id;
      select.addEventListener("change", () => { const controller = value.controllers.find(({ id }) => id === select.value); if (context.location && controller) context.location.navigate(['controllers', controller.controllerKey ?? controller.id, 'jobs']); else choose(controller); }); choose(selected);
    } catch (error) {
      if (!current() || request !== discoveryVersion) return;
      content.replaceChildren(ui.element("p", `Could not discover execution services: ${error instanceof Error ? error.message : "service unavailable"}.`));
      if (!discovery.querySelector("button")) { const retry = ui.button("Refresh controllers"); retry.addEventListener("click", () => { void discover(); }); discovery.append(retry); }
    }
  }
  const initialDiscovery = advertised("controllers.list") ? discover() : Promise.resolve();
  const disposeControllerLocation = advertised('controllers.list') ? context.location?.subscribe((path) => {
    const next = path.length ? path[0] === 'controllers' ? controllers.find(({ controllerKey, id }) => (controllerKey ?? id) === path[1]) : undefined : controllers.find(({ id }) => id === selectedController) ?? controllers.find(({ status }) => status === 'ready');
    if (next?.id !== selectedController) choose(next);
  }) : undefined;
  if (!advertised("controllers.list")) { const provenance = ui.element("div", "", "execution-provenance-copy"); provenance.append(ui.element("p", "Direct execution service", "eyebrow"), ui.element("p", "This private connection has no inferred host or Git controller identity.")); discovery.replaceChildren(provenance); activePanel = render(undefined, context.operations); }
  const disposeNavigation = registerExecutionNavigation(context, {
    ready: initialDiscovery,
    async open(target, isCurrent) {
      if (!current() || !isCurrent() || !advertised("jobs.list")) return false;
      const domainVersion = scopeVersion, catalogVersion = discoveryVersion, selection = selectedController, address = window.location.href;
      const controller = controllers.find(({ controllerKey, status, operations }) => controllerKey === target.controllerKey && status === "ready" && operations.some(({ name }) => name === "jobs.list"));
      if (!controller) return false;
      const jobs = /** @type {Job[]} */ (await context.invoke("jobs.list", { controllerId: controller.id }));
      if (!current() || !isCurrent() || domainVersion !== scopeVersion || catalogVersion !== discoveryVersion || selection !== selectedController || address !== window.location.href) return false;
      const exists = target.kind === "job" ? jobs.some(({ id }) => id === target.jobId) : jobs.some(({ projectId, repositoryId }) => projectId === target.projectId && repositoryId === target.repositoryId);
      if (!exists) return false;
      if (selectedController !== controller.id || !activePanel) choose(controller);
      const panel = activePanel;
      return panel ? panel.applyNavigation(target, jobs, isCurrent) : false;
    }
  });
   return () => { disposeNavigation(); disposeControllerLocation?.(); activePanel?.disposeLocation?.(); disposed = true; ++scopeVersion; ++discoveryVersion; cancellations.clear(); disposeStyles(); container.replaceChildren(); };
}
