// @ts-check
import { record, text } from "./review-data.js";
import { createWorkspaceHosts } from "./workspace-hosts.js";
/** @param {string} id */
function element(id) {
  const value = document.getElementById(id);
  if (!(value instanceof HTMLElement)) throw new Error(`Missing operations element ${id}`);
  return value;
}
const panel = element("operations-panel"), status = element("operations-message"), hosts = element("operations-hosts"), jobs = element("operations-jobs"), workersView = element("operations-workers"), reviews = element("operations-reviews"), details = element("operations-details");
/** @type {import("./types.js").Session | null} */
let session = null;
let epoch = 0;
/** @type {Map<string,string>} */
const retries = new Map();
/** @type {(id:string, repositoryId:string)=>void} */
let openReview = () => {};
/** @param {unknown} value @returns {Record<string,unknown>[]} */
function rows(value) { return Array.isArray(value) ? value.map(record).filter((row) => row !== null) : []; }
/** @param {HTMLElement} target @param {string} value */
function line(target, value) { const node = document.createElement("p"); node.textContent = value; target.append(node); return node; }
/** @param {HTMLElement} target @param {string} label @param {()=>Promise<void>} action */
function button(target, label, action) {
  const node = document.createElement("button"); node.type = "button"; node.className = "button button-secondary"; node.textContent = label;
  node.addEventListener("click", async () => {
    node.disabled = true; const selected = epoch; status.textContent = "Working…";
    try { await action(); if (selected === epoch) status.textContent = "Updated."; }
    catch { if (selected === epoch) status.textContent = "Operation failed. Refresh to verify current state before retrying."; }
    finally { node.disabled = false; }
  }); target.append(node); return node;
}
/** @param {string} path @param {unknown} [body] @param {number} [timeout] */
async function request(path, body, timeout = 35_000) {
  const active = session; if (!active) throw new Error("session required");
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json", "x-dim-csrf": active.csrfToken }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(response.status === 401 ? "session expired" : "operation failed");
  /** @type {unknown} */ const value = await response.json(); return value;
}
const workspaceHosts = createWorkspaceHosts(hosts, request);

export function clearOperations() { session = null; epoch++; retries.clear(); panel.hidden = true; workspaceHosts.clear(); element("operations-consoles").replaceChildren(); jobs.replaceChildren(); workersView.replaceChildren(); reviews.replaceChildren(); details.textContent = ""; element("view-navigation").hidden = true; }
/** @param {import("./types.js").Session} active @param {(id:string, repositoryId:string)=>void} open */
export function showOperations(active, open) {
  clearOperations(); session = active; openReview = open; panel.hidden = !active.capabilities.operations && !active.capabilities.review;
  element("view-navigation").hidden = !active.capabilities.review;
  element("operations-review-section").hidden = !active.capabilities.review;
  element("operations-ci-section").hidden = true;
  element("operations-execution-section").hidden = true;
  if (active.capabilities.review) panel.hidden = true;
  if (active.capabilities.operations || active.capabilities.review) void refresh().catch(() => { status.textContent = "Some services could not refresh. Your workspace drafts are kept; retry the affected host below."; });
}
async function refresh() {
  const active = session, selected = epoch; if (!active) return;
  jobs.replaceChildren(); workersView.replaceChildren(); reviews.replaceChildren(); details.textContent = "";
  status.textContent = "Loading services…";
  let hostsUnavailable = false;
  /** @type {Promise<void>[]} */ const loads = [];
  if (active.capabilities.operations) loads.push((async () => {
    const state = record(await request("/v1/operations/status")); if (selected !== epoch) return;
    const hostLoad = workspaceHosts.refresh(rows(state?.hosts).map((host) => text(host.id)).filter((id) => id !== null), active.roles.includes("operator"));
    const consoles = element("operations-consoles"); consoles.replaceChildren();
    for (const console of rows(state?.consoles)) {
      const name = text(console.name), url = text(console.url); if (!name || !url) continue;
      const link = document.createElement("a"); link.textContent = name; link.href = url; link.rel = "noopener noreferrer"; link.target = "_blank"; consoles.append(link);
    }
    const hostsReady = await hostLoad;
    if (selected !== epoch) return;
    if (active.roles.includes("operator") && state?.executionOperator === true) {
      element("operations-execution-section").hidden = false;
      const workers = rows(await request("/v1/operations/execution/workers")); if (selected !== epoch) return;
      for (const worker of workers) line(workersView, `Worker ${text(worker.id) ?? ""}: ${rows(worker.slots).map((slot) => `${text(slot.id) ?? ""} ${text(slot.state) ?? ""}`).join(", ")} (configured capacity)`);
    }
    if (state?.ci === true) {
      element("operations-ci-section").hidden = false;
      const list = rows(await request("/v1/operations/ci/jobs")); if (selected !== epoch) return;
      for (const job of list) renderJob(job, active.roles.includes("operator") && state?.executionOperator === true);
    }
    hostsUnavailable = !hostsReady;
  })());
  if (active.capabilities.review) loads.push((async () => {
    const lists = await Promise.all(active.repositoryIds.map(async (repositoryId) => rows(await request(`/v1/projects/${active.projectId}/repositories/${repositoryId}/reviews`)).map((review) => ({ ...review, repositoryId }))));
    const list = rows(lists.flat()); if (selected !== epoch) return;
    for (const review of list) {
      const id = text(review.reviewId); const repositoryId = text(review.repositoryId); if (!id || !repositoryId) continue;
      const row = document.createElement("div"); row.className = "operations-row"; reviews.append(row);
      line(row, `${repositoryId}: ${text(review.proposalRef) ?? ""} — ${text(review.status) ?? ""}`);
      button(row, "Open evidence", async () => { setOperationsView(false); openReview(id, repositoryId); });
      if (active.capabilities.promotion && active.roles.includes("operator")) button(row, "Promote reviewed candidate", async () => {
        await request(`/v1/projects/${active.projectId}/repositories/${repositoryId}/reviews/${id}/promotions`, {}); await refresh();
      });
    }
  })());
  const results = await Promise.allSettled(loads); if (selected !== epoch) return;
  status.textContent = results.some((result) => result.status === "rejected") ? "Some services could not refresh. Workspace drafts are kept. Refresh services to retry." : hostsUnavailable ? "Service connections loaded. Workspace status is shown per host." : "Services refreshed.";
}
/** @param {Record<string,unknown>} job @param {boolean} canOperate */
function renderJob(job, canOperate) {
  const id = text(job.id); if (!id) return;
  const row = document.createElement("div"); row.className = "operations-row"; jobs.append(row);
  line(row, `${text(job.jobName) ?? ""} · ${text(job.phase) ?? ""} · ${text(job.outcome) ?? ""} · publication ${text(job.publication) ?? ""}`);
  button(row, "Read diagnostics", async () => {
    const selected = epoch;
    const value = record(await request(`/v1/operations/ci/jobs/${id}`)), result = record(value?.result), logs = record(result?.logs);
    if (selected !== epoch) return;
    details.textContent = "";
    for (const name of ["stdout", "stderr"]) {
      const stream = record(logs?.[name]), base64 = text(stream?.base64);
      if (base64 !== null) line(details, `${name}${stream?.truncated === true ? " (truncated prefix)" : ""}:\n${new TextDecoder().decode(Uint8Array.from(atob(base64), (value) => value.charCodeAt(0)))}`);
    }
    if (!logs) line(details, "No completed diagnostics are available.");
  });
  if (!canOperate) return;
  if (job.phase !== "finished") button(row, "Cancel execution", async () => { await request(`/v1/operations/execution/jobs/${id}/cancel`, {}); await refresh(); });
  else button(row, "Retry execution", async () => {
    let requestId = retries.get(id); if (!requestId) { requestId = crypto.randomUUID(); retries.set(id, requestId); }
    await request(`/v1/operations/execution/jobs/${id}/retry`, { requestId }); await refresh();
  });
}
element("operations-refresh").addEventListener("click", () => { void refresh().catch(() => { status.textContent = "Service refresh failed."; }); });

/** @param {boolean} operations */
function setOperationsView(operations) {
  if (!session) return;
  panel.hidden = !operations;
  element("workspace").hidden = operations || !session.capabilities.review;
  element("show-review").setAttribute("aria-pressed", String(!operations));
  element("show-operations").setAttribute("aria-pressed", String(operations));
}
element("show-review").addEventListener("click", () => setOperationsView(false));
element("show-operations").addEventListener("click", () => setOperationsView(true));
