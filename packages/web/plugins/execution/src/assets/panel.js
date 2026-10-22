// @ts-check
/** @typedef {{name:string,description:string,access:string}} Descriptor */
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebPluginBrowserContext} Context */
/** @typedef {{id:string,title:string,status:"ready"|"unavailable",operations:Descriptor[]}} Controller */
/** @typedef {import('@slop-lab/dim-contracts-ci/query').ExecutionSummary} Job */

/** @param {HTMLElement} container @param {Context} context */
export function mount(container, context) {
  let disposed = false, scopeVersion = 0, discoveryVersion = 0;
  /** @type {Map<string,string>} */ const retryRequests = new Map();
  /** @type {string|undefined} */ let selectedController;
  const { ui } = context, current = () => !disposed && context.isCurrent();
  const advertised = new Set(context.operations.map(({ name }) => name));
  const discovery = ui.element("div"), content = ui.element("div");
  container.append(discovery, content);

  /** @param {string|undefined} controllerId @param {readonly Descriptor[]} operations */
  function render(controllerId, operations) {
    const version = ++scopeVersion;
    let detailVersion = 0, jobsVersion = 0, capacityVersion = 0;
    /** @type {Job[]} */ let loadedJobs = [];
    const scoped = () => current() && version === scopeVersion;
    const allowed = new Set(operations.map(({ name }) => name));
    const invoke = (/** @type {string} */ name, /** @type {Record<string,unknown>} */ input) => {
      if (!scoped()) return Promise.reject(new Error("Controller selection changed"));
      return context.invoke(name, controllerId === undefined ? input : { ...input, controllerId });
    };
    content.replaceChildren();
    const toolbar = ui.element("div", "", "feature-actions"), filters = ui.element("div", "", "workspace-filters");
    const status = ui.element("p"), jobs = ui.element("section"), detail = ui.element("section"), capacity = ui.element("section");
    const search = ui.input(filters, "Search jobs"), state = ui.select(filters, "Job state", [
      { value: "", label: "All states" }, { value: "queued", label: "Queued" }, { value: "assigned", label: "Assigned" },
      { value: "running", label: "Running" }, { value: "recovering", label: "Recovering" }, { value: "finished", label: "Finished" }
    ]);
    search.placeholder = "Job, ID, project or repository";
    content.append(ui.element("p", "Inspect recent jobs, read captured logs and manage worker capacity."), toolbar, filters, status, jobs, detail, capacity);

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
      const visible = loadedJobs.filter((job) => (!phase || job.phase === phase) && (!query || [job.id, job.jobName, job.projectId, job.repositoryId].some((value) => value.toLowerCase().includes(query))));
      jobs.replaceChildren(ui.element("h3", "Recent jobs"));
      if (!loadedJobs.length) { jobs.append(ui.element("p", "No recent jobs.")); return; }
      if (!visible.length) { jobs.append(ui.element("p", "No jobs match the current search and state filter.")); return; }
      const table = ui.table(["Job", "Repository", "State", "Created", "Details"], visible.map((job) => [job.jobName, `${job.projectId}/${job.repositoryId}`, `${job.phase}${job.outcome ? ` / ${job.outcome}` : ""}`, new Date(job.createdAt).toLocaleString(), ""]));
      const rows = table.querySelectorAll("tbody tr");
      visible.forEach((job, index) => { const cell = rows[index]?.lastElementChild; if (cell instanceof HTMLElement) actionButton(cell, "View job", () => open(job)); });
      jobs.append(table);
    }
    /** @param {Job} job */
    async function open(job) {
      const request = ++detailVersion;
      const value = /** @type {import('zod').infer<typeof import('@slop-lab/dim-contracts-ci/query').executionDetailSchema>} */ (await invoke("jobs.detail", { id: job.id }));
      if (!scoped() || request !== detailVersion) return;
      const metadata = [["Job ID", value.job.id], ["Project / repository", `${value.job.projectId} / ${value.job.repositoryId}`], ["Worker / slot", `${value.job.workerId ?? "unassigned"} / ${value.job.slotId ?? "unassigned"}`], ["Outcome", value.job.outcome ?? "pending"], ["Publication", value.job.publication]];
      detail.replaceChildren(ui.element("p", "Selected job details are retained independently of list filters.", "field-hint"), ui.element("h3", `${value.job.jobName} — ${value.job.phase}`), ui.table(["Field", "Value"], metadata));
      if (value.result) {
        for (const stream of ["stdout", "stderr"]) {
          const log = stream === "stdout" ? value.result.logs.stdout : value.result.logs.stderr;
          let text;
          try { text = new TextDecoder().decode(Uint8Array.from(atob(log.base64), (char) => char.charCodeAt(0))); }
          catch { text = "Captured log could not be decoded."; }
          detail.append(ui.element("h4", `${stream}${log.truncated ? " (truncated by execution service)" : ""}`), ui.element("pre", text || "No captured output.", "log-output"));
        }
      } else detail.append(ui.element("p", "Logs become available after this job completes."));
      if (allowed.has("jobs.cancel") && ["queued", "assigned", "running", "recovering"].includes(value.job.phase)) actionButton(detail, "Cancel execution", async (button) => {
        if (!window.confirm(`Cancel ${value.job.jobName} (${value.job.id})?`)) { ui.feedback(status, "Cancellation dismissed."); return false; }
        await invoke("jobs.cancel", { id: value.job.id }); return accepted(button, "Cancellation accepted.", [["job list", refreshJobs], ["job details", () => open(job)]]);
      });
      if (allowed.has("jobs.retry") && value.job.phase === "finished") actionButton(detail, "Retry execution", async (button) => {
        const key = `${controllerId ?? "direct"}/${value.job.id}`;
        let requestId = retryRequests.get(key); if (!requestId) { requestId = crypto.randomUUID(); retryRequests.set(key, requestId); }
        await invoke("jobs.retry", { id: value.job.id, requestId }); return accepted(button, "Retry execution accepted.", [["job list", refreshJobs]]);
      });
    }
    async function refreshJobs() {
      const request = ++jobsVersion, values = /** @type {Job[]} */ (await invoke("jobs.list", {}));
      if (!scoped() || request !== jobsVersion) return;
      loadedJobs = values; paintJobs();
    }
    async function refreshCapacity() {
      const request = ++capacityVersion;
      try {
        const workers = /** @type {Array<{id:string,slots:Array<{id:string,state:string,executionKind:string}>}>} */ (await invoke("workers.list", {}));
        if (!scoped() || request !== capacityVersion) return;
        capacity.replaceChildren(ui.element("h3", "Worker capacity"));
        if (!workers.length) { capacity.append(ui.element("p", "No execution workers registered.")); return; }
        const rows = workers.flatMap((worker) => worker.slots.map((slot) => [worker.id, slot.id, slot.state, slot.executionKind]));
        capacity.append(ui.table(["Worker", "Slot", "State", "Execution kind"], rows));
      } catch (error) {
        if (scoped() && request === capacityVersion) { capacity.replaceChildren(ui.element("h3", "Worker capacity")); const message = ui.element("p"); ui.feedback(message, `Worker capacity is unavailable: ${error instanceof Error ? error.message : "service unavailable"}. Jobs remain available; retry capacity independently.`, "error"); capacity.append(message); }
      }
    }
    search.addEventListener("input", paintJobs); state.addEventListener("change", paintJobs);
    if (allowed.has("jobs.list")) actionButton(toolbar, "Refresh jobs", refreshJobs);
    if (allowed.has("workers.list")) { actionButton(toolbar, "Refresh worker capacity", refreshCapacity); void refreshCapacity(); }
    if (allowed.has("jobs.list")) void refreshJobs().catch((error) => { if (scoped()) ui.feedback(status, `Could not load jobs: ${error instanceof Error ? error.message : "service unavailable"}. Use Refresh jobs to retry.`, "error"); });
  }

  async function discover() {
    const request = ++discoveryVersion; ++scopeVersion;
    for (const select of discovery.querySelectorAll("select")) select.disabled = true;
    content.replaceChildren(ui.element("p", "Discovering execution services…"));
    try {
      const value = /** @type {{controllers:Controller[]}} */ (await context.invoke("controllers.list", {}));
      if (!current() || request !== discoveryVersion) return;
      discovery.replaceChildren();
      const select = ui.select(discovery, "Controller", value.controllers.map((controller) => ({ value: controller.id, label: `${controller.title}${controller.status === "unavailable" ? " (unavailable)" : ""}` })));
      const refresh = ui.button("Refresh controllers"); refresh.addEventListener("click", () => { void discover(); }); discovery.append(refresh);
      const selected = value.controllers.find(({ id }) => id === selectedController) ?? value.controllers.find(({ status }) => status === "ready") ?? value.controllers[0];
      const choose = (/** @type {Controller|undefined} */ controller) => {
        selectedController = controller?.id; ++scopeVersion;
        if (!controller || controller.status !== "ready") { content.replaceChildren(ui.element("p", controller ? "Execution is unavailable on this controller. Refresh controllers after connecting its execution service." : "No controllers are configured.")); return; }
        render(controller.id, controller.operations.filter(({ name }) => advertised.has(name)));
      };
      if (selected) select.value = selected.id;
      select.addEventListener("change", () => choose(value.controllers.find(({ id }) => id === select.value))); choose(selected);
    } catch (error) {
      if (!current() || request !== discoveryVersion) return;
      content.replaceChildren(ui.element("p", `Could not discover execution services: ${error instanceof Error ? error.message : "service unavailable"}.`));
      if (!discovery.querySelector("button")) { const retry = ui.button("Refresh controllers"); retry.addEventListener("click", () => { void discover(); }); discovery.append(retry); }
    }
  }
  if (advertised.has("controllers.list")) void discover(); else render(undefined, context.operations);
  return () => { disposed = true; ++scopeVersion; ++discoveryVersion; container.replaceChildren(); };
}
