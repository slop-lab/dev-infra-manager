// @ts-check
import { registerExecutionNavigation } from "./navigation.js";
/** @typedef {{name:string,description:string,access:string}} Descriptor */
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebPluginBrowserContext} Context */
/** @typedef {{id:string,controllerKey?:string,title:string,status:"ready"|"unavailable",operations:Descriptor[]}} Controller */
/** @typedef {import('@slop-lab/dim-contracts-ci/query').ExecutionSummary} Job */
/** @typedef {{id:string,taskType:string,executionKind:string,phase:string}} Task */
/** @typedef {{id:string,state:string,executionKind:string,job?:Job|Task}} WorkerSlot */
/** @typedef {{id:string,slots:WorkerSlot[]}} Worker */
/** @typedef {{kind:'repository-jobs',controllerKey:string,projectId:string,repositoryId:string}|{kind:'job',controllerKey:string,jobId:string}} NavigationTarget */
/** @typedef {import('@slop-lab/dim-contracts-ci/query').ExecutionSummary['admission']} Admission */
/** @typedef {NonNullable<import('@slop-lab/dim-contracts-ci/query').ExecutionSummary['completion']>} Completion */

/** @param {Admission} admission */
export function admissionGuidance(admission) {
  if (!admission) return "";
  if (admission.phase === "authorize") {
    if (admission.code === "timeout") return "Git authorization timed out. Check Git service load and reconnect this controller to the current generation before retrying.";
    if (admission.code === "unavailable") return "Git authorization is unavailable. Check the Git service and reconnect this controller to the current generation before retrying.";
    return "Git authorization evidence is stale. Reconnect this controller to the current generation before retrying.";
  }
  if (admission.code === "timeout") return "Reading the candidate Git proof timed out. Check Git proof load, then retry.";
  if (admission.code === "unavailable") return "The candidate Git proof is unavailable. Check repository access and Git service load, then retry.";
  return "The candidate Git proof is stale. Resolve a fresh review for the current candidate before retrying.";
}
/** @param {Completion} completion */
export function completionGuidance(completion) {
  if (completion.kind === "executor-failure" && "code" in completion) {
    if (completion.code === "candidate-read-timeout") return "Execution infrastructure timed out reading the candidate. Check Git proof load, then retry.";
    if (completion.code === "candidate-read-stale") return "Execution infrastructure found stale candidate evidence. Resolve a fresh review before retrying.";
    return "Execution infrastructure failed before a guest result was available. Inspect worker capacity and retry.";
  }
  if (completion.kind === "exited" && "exitCode" in completion) return completion.exitCode === 0 ? "Guest command completed successfully." : `Guest command exited with code ${completion.exitCode}. Inspect the captured guest logs before retrying.`;
  if (completion.kind === "signaled" && "signal" in completion) return `Guest command ended from signal ${completion.signal}. Inspect the captured guest logs before retrying.`;
  if (completion.kind === "timed-out") return "Guest command exceeded its execution deadline.";
  if (completion.kind === "output-limit-exceeded") return "Guest command exceeded the configured output limit.";
  if (completion.kind === "lease-lost") return "Worker ownership was lost before completion. Inspect worker capacity and retry.";
  return "Execution was cancelled.";
}

/** @param {HTMLElement} container @param {Context} context */
export function mount(container, context) {
  let disposed = false, scopeVersion = 0, discoveryVersion = 0;
  /** @type {Map<string,string>} */ const retryRequests = new Map();
  /** @type {string|undefined} */ let selectedController;
  /** @type {Controller[]} */ let controllers = [];
  /** @type {HTMLSelectElement|undefined} */ let controllerSelect;
  /** @type {{applyNavigation(target:NavigationTarget,values:Job[],isCurrent:()=>boolean):Promise<boolean>}|undefined} */ let activePanel;
  const { ui } = context, current = () => !disposed && context.isCurrent();
  /** @param {string} name */ const advertised = (name) => context.operations.some((operation) => operation.name === name);
  const discovery = ui.element("div"), content = ui.element("div");
  container.append(discovery, content);

  /** @param {Controller|undefined} controller @param {readonly Descriptor[]} operations */
  function render(controller, operations) {
    const controllerId = controller?.id, controllerKey = controller?.controllerKey;
    const version = ++scopeVersion;
    let detailVersion = 0, jobsVersion = 0, capacityVersion = 0;
    let activeDetail = "";
    /** @type {{projectId:string,repositoryId:string}|undefined} */ let repositoryTarget;
    /** @type {Job[]} */ let loadedJobs = [];
    const scoped = () => current() && version === scopeVersion;
    /** @param {string} name */ const allowed = (name) => operations.some((operation) => operation.name === name) && advertised(name);
    const invoke = (/** @type {string} */ name, /** @type {Record<string,unknown>} */ input) => {
      if (!scoped()) return Promise.reject(new Error("Controller selection changed"));
      return context.invoke(name, controllerId === undefined ? input : { ...input, controllerId });
    };
    content.replaceChildren();
    const toolbar = ui.element("div", "", "feature-actions"), filters = ui.element("div", "", "workspace-filters");
    const status = ui.element("p"), filterContext = ui.element("div"), jobs = ui.element("section"), detail = ui.element("section"), capacity = ui.element("section");
    const search = ui.input(filters, "Search jobs"), state = ui.select(filters, "Job state", [
      { value: "", label: "All states" }, { value: "queued", label: "Queued" }, { value: "assigned", label: "Assigned" },
      { value: "running", label: "Running" }, { value: "recovering", label: "Recovering" }, { value: "finished", label: "Finished" }
    ]);
    search.placeholder = "Job, ID, project or repository";
    content.append(ui.element("p", "Inspect recent jobs, read captured logs and manage worker capacity."), toolbar, filters, filterContext, status, jobs, detail, capacity);

    /** @param {HTMLElement} parent @param {string} label @param {(button:HTMLButtonElement)=>Promise<boolean|void>} action */
    function actionButton(parent, label, action) {
      const node = ui.button(label);
      node.addEventListener("click", async () => {
        if (!scoped()) return;
        node.disabled = true; ui.feedback(status, `${label}…`);
        try { const result = await action(node); if (scoped() && result !== false) ui.feedback(status, `${label} completed.`); }
        catch (error) { if (scoped()) ui.feedback(status, `${label} failed: ${error instanceof Error ? error.message : "service unavailable"}. Retry when the service is available.`, "error"); }
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
      const table = ui.table(["Job", "Repository", "State", "Created", "Details"], visible.map((job) => [job.jobName, `${job.projectId}/${job.repositoryId}`, `${job.phase}${job.outcome ? ` / ${job.outcome}` : ""}`, new Date(job.createdAt).toLocaleString(), ""]));
      const rows = table.querySelectorAll("tbody tr");
      visible.forEach((job, index) => { const cell = rows[index]?.lastElementChild; if (cell instanceof HTMLElement) actionButton(cell, "View job", () => open(job)); });
      jobs.append(table);
    }
    /** @param {Job} job @param {()=>boolean} [isCurrent] */
    async function open(job, isCurrent = scoped) {
      const request = ++detailVersion;
      const value = /** @type {import('zod').infer<typeof import('@slop-lab/dim-contracts-ci/query').executionDetailSchema>} */ (await invoke("jobs.detail", { id: job.id }));
      if (!scoped() || !isCurrent() || request !== detailVersion) return false;
      activeDetail = value.job.id;
      const metadata = [["Job ID", value.job.id], ["Project / repository", `${value.job.projectId} / ${value.job.repositoryId}`], ["Worker / slot", `${value.job.workerId ?? "unassigned"} / ${value.job.slotId ?? "unassigned"}`], ["Outcome", value.job.outcome ?? "pending"], ["Publication", value.job.publication]];
      detail.replaceChildren(ui.element("p", "Selected job details are retained independently of list filters.", "field-hint"), ui.element("h3", `${value.job.jobName} — ${value.job.phase}`), ui.table(["Field", "Value"], metadata));
      if (value.job.admission) detail.append(ui.element("h4", "Admission guidance"), ui.element("p", admissionGuidance(value.job.admission), "field-hint"));
      if (value.job.completion) detail.append(ui.element("h4", "Completion"), ui.element("p", completionGuidance(value.job.completion), "field-hint"));
      if (value.result) {
        for (const stream of ["stdout", "stderr"]) {
          const log = stream === "stdout" ? value.result.logs.stdout : value.result.logs.stderr;
          let text;
          try { text = new TextDecoder().decode(Uint8Array.from(atob(log.base64), (char) => char.charCodeAt(0))); }
          catch { text = "Captured log could not be decoded."; }
          detail.append(ui.element("h4", `${stream}${log.truncated ? " (truncated by execution service)" : ""}`), ui.element("pre", text || "No captured output.", "log-output"));
        }
      } else detail.append(ui.element("p", "Logs become available after this job completes."));
      if (value.job.phase === "queued") detail.append(ui.element("p", `Waiting for an active worker with a matching ${value.job.executionKind} slot. Inspect Worker capacity below; configured idle slots do not prove the worker process is running.`, "field-hint"));
      if (allowed("jobs.cancel") && ["queued", "assigned", "running", "recovering"].includes(value.job.phase)) actionButton(detail, "Cancel execution", async (button) => {
        if (!window.confirm(`Cancel ${value.job.jobName} (${value.job.id})?`)) { ui.feedback(status, "Cancellation dismissed."); return false; }
        await invoke("jobs.cancel", { id: value.job.id }); return accepted(button, "Cancellation accepted.", [["job list", refreshJobs], ["job details", () => open(job)]]);
      });
      if (allowed("jobs.retry") && value.job.phase === "finished") actionButton(detail, "Retry execution", async (button) => {
        const key = `${controllerId ?? "direct"}/${value.job.id}`;
        let requestId = retryRequests.get(key); if (!requestId) { requestId = crypto.randomUUID(); retryRequests.set(key, requestId); }
        await invoke("jobs.retry", { id: value.job.id, requestId }); return accepted(button, "Retry execution accepted.", [["job list", refreshJobs]]);
      });
      if (controllerKey && context.navigation.hasFeature("native-git")) context.ui.navigationAction(detail, {
        label: "Open repository reviews", status, isCurrent: () => scoped() && activeDetail === value.job.id,
        open: () => context.navigation.openFeature("native-git", { kind: "repository", controllerKey, projectId: value.job.projectId, repositoryId: value.job.repositoryId })
      });
      return true;
    }
    /** @param {Job[]} values */
    function applyJobs(values) { loadedJobs = values; paintJobs(); }
    async function refreshJobs() {
      const request = ++jobsVersion, values = /** @type {Job[]} */ (await invoke("jobs.list", {}));
      if (!scoped() || request !== jobsVersion) return;
      applyJobs(values);
    }
    function workerSetup() {
      const setup = document.createElement("details"); setup.append(ui.element("summary", "Set up execution workers"));
      setup.append(ui.element("p", "Install the execution-worker host plugin on the host that will run jobs. Worker capacity is configured by an operator; installing the plugin alone does not start workers."));
      setup.append(ui.element("p", "Configure reviewed container, VM or task slots in the execution service, deploy that configuration, then run control-plane connect to write the matching private worker.json. Each worker needs its own configured identity and state directory."));
      setup.append(ui.element("p", "On the selected worker host, start the generated configuration:"), ui.element("pre", "dim execution worker /absolute/path/to/worker.json", "log-output"));
      setup.append(ui.element("p", "Keep that process running, or supervise it as a host service. Remote workers need connectivity to the configured service endpoints. Idle slots describe reservations; they do not prove that a worker process is polling."));
      const guide = ui.element("a", "Execution worker setup guide"); guide.setAttribute("href", "https://github.com/slop-lab/dev-infra-manager/blob/development/docs/guides/ci-runners.md"); guide.setAttribute("target", "_blank"); guide.setAttribute("rel", "noopener noreferrer"); setup.append(guide);
      return setup;
    }
    async function refreshCapacity() {
      const request = ++capacityVersion;
      try {
        const workers = /** @type {Worker[]} */ (await invoke("workers.list", {}));
        if (!scoped() || request !== capacityVersion) return;
        capacity.replaceChildren(ui.element("h3", "Worker capacity"));
        if (!workers.length) { capacity.append(ui.element("p", "No execution workers configured. Jobs will remain queued until matching capacity is configured and its worker is started."), workerSetup()); return; }
        const slots = workers.flatMap((worker) => worker.slots.map((slot) => ({ worker, slot })));
        const table = ui.table(["Worker", "Slot", "State", "Execution kind", "Current work", "Details"], slots.map(({ worker, slot }) => {
          const currentWork = !slot.job ? "None" : "jobName" in slot.job ? `${slot.job.jobName} · ${slot.job.projectId}/${slot.job.repositoryId}` : `${slot.job.taskType} / ${slot.job.executionKind}`;
          return [worker.id, slot.id, slot.state, slot.executionKind, currentWork, ""];
        }));
        const rows = table.querySelectorAll("tbody tr");
        slots.forEach(({ slot }, index) => {
          const cell = rows[index]?.lastElementChild;
          const job = slot.job;
          if (cell instanceof HTMLElement && job && "jobName" in job) actionButton(cell, "View worker job", () => open(job));
        });
        capacity.append(table, workerSetup());
      } catch {
        if (scoped() && request === capacityVersion) { capacity.replaceChildren(ui.element("h3", "Worker capacity")); const message = ui.element("p"); ui.feedback(message, "Worker capacity read is unavailable. The selected execution result above is unchanged. Retry capacity independently; configured slots and worker connectivity could not be confirmed.", "error"); capacity.append(message); }
      }
    }
    search.addEventListener("input", paintJobs); state.addEventListener("change", paintJobs);
    if (allowed("jobs.list")) actionButton(toolbar, "Refresh jobs", refreshJobs);
    if (allowed("workers.list")) { actionButton(toolbar, "Refresh worker capacity", refreshCapacity); void refreshCapacity(); }
    const jobsReady = allowed("jobs.list") ? refreshJobs() : Promise.resolve();
    void jobsReady.catch((error) => { if (scoped()) ui.feedback(status, `Could not load jobs: ${error instanceof Error ? error.message : "service unavailable"}. Use Refresh jobs to retry.`, "error"); });
    /** @param {NavigationTarget} target @param {Job[]} values @param {()=>boolean} isCurrent */
    async function applyNavigation(target, values, isCurrent) {
      if (!scoped() || !isCurrent()) return false;
      const job = target.kind === "job" ? values.find(({ id }) => id === target.jobId) : undefined;
      if (target.kind === "job" ? !job : !values.some(({ projectId, repositoryId }) => projectId === target.projectId && repositoryId === target.repositoryId)) return false;
      ++jobsVersion;
      applyJobs(values);
      if (target.kind === "job") return job ? open(job, isCurrent) : false;
      repositoryTarget = { projectId: target.projectId, repositoryId: target.repositoryId }; search.value = ""; state.value = "";
      filterContext.replaceChildren(ui.element("p", `Showing jobs for ${target.projectId}/${target.repositoryId}.`, "workspace-feedback"));
      const clear = ui.button("Clear repository filter", "secondary"); clear.addEventListener("click", () => { repositoryTarget = undefined; filterContext.replaceChildren(); paintJobs(); }); filterContext.append(clear);
      paintJobs(); return true;
    }
    return { applyNavigation };
  }

  /** @param {Controller|undefined} controller */
  function choose(controller) {
    selectedController = controller?.id;
    if (controllerSelect && controller) controllerSelect.value = controller.id;
    if (!controller || controller.status !== "ready") { ++scopeVersion; activePanel = undefined; content.replaceChildren(ui.element("p", controller ? "Execution is unavailable on this controller. Refresh controllers after connecting its execution service." : "No controllers are configured.")); return; }
    activePanel = render(controller, controller.operations.filter(({ name }) => advertised(name)));
  }

  async function discover() {
    const request = ++discoveryVersion; ++scopeVersion; activePanel = undefined;
    for (const select of discovery.querySelectorAll("select")) select.disabled = true;
    content.replaceChildren(ui.element("p", "Discovering execution services…"));
    try {
      const value = /** @type {{controllers:Controller[]}} */ (await context.invoke("controllers.list", {}));
      if (!current() || request !== discoveryVersion) return;
      controllers = value.controllers;
      discovery.replaceChildren();
      const select = ui.select(discovery, "Controller", value.controllers.map((controller) => ({ value: controller.id, label: `${controller.title}${controller.status === "unavailable" ? " (unavailable)" : ""}` })));
      controllerSelect = select;
      const refresh = ui.button("Refresh controllers"); refresh.addEventListener("click", () => { void discover(); }); discovery.append(refresh);
      const selected = value.controllers.find(({ id }) => id === selectedController) ?? value.controllers.find(({ status }) => status === "ready") ?? value.controllers[0];
      if (selected) select.value = selected.id;
      select.addEventListener("change", () => choose(value.controllers.find(({ id }) => id === select.value))); choose(selected);
    } catch (error) {
      if (!current() || request !== discoveryVersion) return;
      content.replaceChildren(ui.element("p", `Could not discover execution services: ${error instanceof Error ? error.message : "service unavailable"}.`));
      if (!discovery.querySelector("button")) { const retry = ui.button("Refresh controllers"); retry.addEventListener("click", () => { void discover(); }); discovery.append(retry); }
    }
  }
  const initialDiscovery = advertised("controllers.list") ? discover() : Promise.resolve();
  if (!advertised("controllers.list")) activePanel = render(undefined, context.operations);
  const disposeNavigation = registerExecutionNavigation(context, {
    ready: initialDiscovery,
    async open(target, isCurrent) {
      if (!current() || !isCurrent() || !advertised("jobs.list")) return false;
      const domainVersion = scopeVersion, catalogVersion = discoveryVersion, selection = selectedController;
      const controller = controllers.find(({ controllerKey, status, operations }) => controllerKey === target.controllerKey && status === "ready" && operations.some(({ name }) => name === "jobs.list"));
      if (!controller) return false;
      const jobs = /** @type {Job[]} */ (await context.invoke("jobs.list", { controllerId: controller.id }));
      if (!current() || !isCurrent() || domainVersion !== scopeVersion || catalogVersion !== discoveryVersion || selection !== selectedController) return false;
      const exists = target.kind === "job" ? jobs.some(({ id }) => id === target.jobId) : jobs.some(({ projectId, repositoryId }) => projectId === target.projectId && repositoryId === target.repositoryId);
      if (!exists) return false;
      if (selectedController !== controller.id || !activePanel) choose(controller);
      const panel = activePanel;
      return panel ? panel.applyNavigation(target, jobs, isCurrent) : false;
    }
  });
  return () => { disposeNavigation(); disposed = true; ++scopeVersion; ++discoveryVersion; container.replaceChildren(); };
}
