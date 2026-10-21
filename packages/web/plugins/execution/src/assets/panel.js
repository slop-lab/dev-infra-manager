// @ts-check
/** @typedef {{name:string,description:string,access:string}} Descriptor */
/** @typedef {{operations:Descriptor[],invoke(name:string,input?:unknown):Promise<unknown>,isCurrent():boolean}} Context */
/** @typedef {import('@slop-lab/dim-contracts-ci/query').ExecutionSummary} Job */
/** @param {string} tag @param {string} [text] */
function element(tag, text = "") { const node = document.createElement(tag); node.textContent = text; return node; }
/** @param {HTMLElement} container @param {Context} context */
export function mount(container, context) {
  let disposed = false;
  /** @type {Map<string,string>} */ const retryRequests = new Map();
  const current = () => !disposed && context.isCurrent();
  const allowed = new Set(context.operations.map((operation) => operation.name));
  const status = element("p"); status.setAttribute("role", "status");
  const jobs = element("div"), detail = element("section"), capacity = element("section");
  const toolbar = element("div"); toolbar.className = "feature-actions";
  container.append(element("p", "Inspect recent CI jobs, read captured logs and manage worker capacity."), toolbar, status, jobs, detail, capacity);
  /** @param {HTMLElement} parent @param {string} label @param {(button:HTMLButtonElement)=>Promise<boolean|void>} action */
  function button(parent, label, action) {
    const node = document.createElement("button"); node.type = "button"; node.className = "button button-secondary"; node.textContent = label;
    node.addEventListener("click", async () => {
      node.disabled = true; status.textContent = `${label}…`;
      try { const result = await action(node); if (current() && result !== false) status.textContent = `${label} completed.`; }
      catch (error) { if (current()) { status.textContent = `${label} failed: ${error instanceof Error ? error.message : "service unavailable"}. Retry when the service is available.`; } }
      finally { if (current()) node.disabled = node.dataset.accepted === "true"; }
    }); parent.append(node); return node;
  }
  /** @param {HTMLButtonElement} button @param {string} receipt @param {Array<[string,()=>Promise<unknown>]>} reads */
  async function accepted(button, receipt, reads) {
    button.dataset.accepted = "true"; status.textContent = receipt;
    const results = await Promise.allSettled(reads.map(([, read]) => read()));
    if (current()) {
      const failed = reads.filter((_, index) => results[index]?.status === "rejected").map(([name]) => name);
      status.textContent = failed.length ? `${receipt} Latest ${failed.join(" and ")} could not refresh. Refresh this view to inspect current state; the action was accepted.` : receipt;
    }
    return false;
  }
  /** @param {Job} job */
  async function open(job) {
    const value = /** @type {import('zod').infer<typeof import('@slop-lab/dim-contracts-ci/query').executionDetailSchema>} */ (await context.invoke("jobs.detail", { id: job.id }));
    if (!current()) return;
    detail.replaceChildren(element("h3", `${value.job.jobName} — ${value.job.phase}`));
    const metadata = element("dl");
    for (const [label, text] of [["Job ID", value.job.id], ["Project / repository", `${value.job.projectId} / ${value.job.repositoryId}`], ["Worker / slot", `${value.job.workerId ?? "unassigned"} / ${value.job.slotId ?? "unassigned"}`], ["Outcome", value.job.outcome ?? "pending"], ["Publication", value.job.publication]]) metadata.append(element("dt", label), element("dd", text));
    detail.append(metadata);
    if (value.result) {
      for (const stream of ["stdout", "stderr"]) {
        const log = stream === "stdout" ? value.result.logs.stdout : value.result.logs.stderr;
        let text;
        try { const bytes = Uint8Array.from(atob(log.base64), (char) => char.charCodeAt(0)); text = new TextDecoder().decode(bytes); }
        catch { text = "Captured log could not be decoded."; }
        const pre = element("pre", text || "No captured output."); pre.className = "log-output";
        detail.append(element("h4", `${stream}${log.truncated ? " (truncated by execution service)" : ""}`), pre);
      }
    } else detail.append(element("p", "Logs become available after this job completes."));
    if (allowed.has("jobs.cancel") && ["queued", "assigned", "running", "recovering"].includes(value.job.phase)) button(detail, "Cancel execution", async (button) => {
      if (!window.confirm(`Cancel ${value.job.jobName} (${value.job.id})?`)) { status.textContent = "Cancellation dismissed."; return false; }
      await context.invoke("jobs.cancel", { id: value.job.id }); return accepted(button, "Cancellation accepted.", [["job list", refresh], ["job details", () => open(job)]]);
    });
    if (allowed.has("jobs.retry") && value.job.phase === "finished") button(detail, "Retry execution", async (button) => {
      let requestId = retryRequests.get(value.job.id); if (!requestId) { requestId = crypto.randomUUID(); retryRequests.set(value.job.id, requestId); }
      await context.invoke("jobs.retry", { id: value.job.id, requestId }); return accepted(button, "Retry execution accepted.", [["job list", refresh]]);
    });
  }
  async function refresh() {
    const values = /** @type {Job[]} */ (await context.invoke("jobs.list", {}));
    if (!current()) return;
    jobs.replaceChildren();
    if (!values.length) { jobs.append(element("p", "No recent CI jobs.")); return; }
    const table = element("table"), head = element("tr");
    for (const label of ["Job", "Repository", "State", "Created", "Details"]) head.append(element("th", label));
    const body = element("tbody"); table.append(head, body);
    for (const job of values) {
      const row = element("tr"), actions = element("td");
      row.append(element("td", job.jobName), element("td", `${job.projectId}/${job.repositoryId}`), element("td", `${job.phase}${job.outcome ? ` / ${job.outcome}` : ""}`), element("td", new Date(job.createdAt).toLocaleString()), actions);
      button(actions, "View job", () => open(job)); body.append(row);
    }
    jobs.append(table);
  }
  button(toolbar, "Refresh jobs", refresh);
  if (allowed.has("workers.list")) button(toolbar, "Refresh worker capacity", async () => {
    const workers = /** @type {Array<{id:string,slots:Array<{id:string,state:string,executionKind:string}>}>} */ (await context.invoke("workers.list", {}));
    if (!current()) return;
    capacity.replaceChildren(element("h3", "Worker capacity"));
    if (!workers.length) capacity.append(element("p", "No execution workers registered."));
    for (const worker of workers) {
      capacity.append(element("h4", worker.id)); const slots = element("ul");
      for (const slot of worker.slots) slots.append(element("li", `${slot.id}: ${slot.state} (${slot.executionKind})`)); capacity.append(slots);
    }
  });
  void refresh().catch((error) => { if (current()) status.textContent = `Could not load jobs: ${error instanceof Error ? error.message : "service unavailable"}. Use Refresh jobs to retry.`; });
  return () => { disposed = true; container.replaceChildren(); };
}
