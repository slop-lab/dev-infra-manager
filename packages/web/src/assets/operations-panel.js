// @ts-check
import { record, text } from "./review-data.js";
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
  if (!response.ok) throw new Error("operation failed");
  /** @type {unknown} */ const value = await response.json(); return value;
}
export function clearOperations() { session = null; epoch++; retries.clear(); panel.hidden = true; hosts.replaceChildren(); jobs.replaceChildren(); workersView.replaceChildren(); reviews.replaceChildren(); details.textContent = ""; element("view-navigation").hidden = true; }
/** @param {import("./types.js").Session} active @param {(id:string, repositoryId:string)=>void} open */
export function showOperations(active, open) {
  clearOperations(); session = active; openReview = open; panel.hidden = !active.capabilities.operations && !active.capabilities.review;
  element("view-navigation").hidden = !active.capabilities.review;
  element("operations-review-section").hidden = !active.capabilities.review;
  element("operations-ci-section").hidden = true;
  element("operations-execution-section").hidden = true;
  if (active.capabilities.review) panel.hidden = true;
  if (active.capabilities.operations || active.capabilities.review) void refresh().catch(() => { status.textContent = "Some services are unavailable. Refresh after checking their connected generation."; });
}
async function refresh() {
  const active = session, selected = epoch; if (!active) return;
  hosts.replaceChildren(); jobs.replaceChildren(); workersView.replaceChildren(); reviews.replaceChildren(); details.textContent = "";
  status.textContent = "Loading services…";
  /** @type {Promise<void>[]} */ const loads = [];
  if (active.capabilities.operations) loads.push((async () => {
    const state = record(await request("/v1/operations/status")); if (selected !== epoch) return;
    for (const host of rows(state?.hosts)) {
      const id = text(host.id); if (!id) continue;
      const section = document.createElement("section"); section.className = "operations-card"; hosts.append(section); line(section, `Host: ${id}`);
      if (active.roles.includes("operator")) renderCreateWorkspace(section, id);
      const workspaces = rows(await request(`/v1/operations/hosts/${encodeURIComponent(id)}/workspaces`)); if (selected !== epoch) return;
      for (const workspace of workspaces) renderWorkspace(section, id, workspace, active.roles.includes("operator"));
    }
    for (const console of rows(state?.consoles)) {
      const name = text(console.name), url = text(console.url); if (!name || !url) continue;
      const link = document.createElement("a"); link.textContent = name; link.href = url; link.rel = "noopener noreferrer"; link.target = "_blank"; hosts.append(link);
    }
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
  status.textContent = results.some((result) => result.status === "rejected") ? "Some services are unavailable. Refresh after checking their connected generation." : "Services refreshed.";
}
/** @param {HTMLElement} parent @param {string} host */
function renderCreateWorkspace(parent, host) {
  const form = document.createElement("form"); form.className = "operations-create"; parent.append(form);
  const heading = document.createElement("h3"); heading.textContent = "Create workspace"; form.append(heading);
  /** @param {string} name @param {string} label @param {string} [value] */
  function input(name, label, value = "") {
    const field = document.createElement("label"), control = document.createElement("input");
    field.textContent = `${label} `; control.name = name; control.value = value;
    control.setAttribute("aria-label", `${label} on ${host}`); field.append(control); form.append(field); return control;
  }
  const source = input("source", "Git URL or dim://PROJECT"); source.type = "url"; source.required = true; source.placeholder = "ssh://git@example.com/project.git";
  const name = input("name", "Workspace name"); name.required = true; name.pattern = "[a-z0-9][a-z0-9._-]{0,47}";
  const repositories = input("repositories", "Managed repositories (comma separated, optional)");
  const workingDirectory = input("workingDirectory", "Managed working repository (optional)");
  const ref = input("ref", "Git ref (optional)");
  const runtime = input("runtime", "Runtime", "container"); runtime.required = true; runtime.pattern = "[a-z][a-z0-9-]{0,31}";
  const image = input("image", "Image (optional)"); image.placeholder = "Container image or VM fingerprint";
  const cpuCount = input("cpuCount", "CPU limit (optional)"), memory = input("memory", "Memory limit (optional)"), pidsLimit = input("pidsLimit", "PID limit (optional)");
  line(form, "Empty limits use the host defaults. Use unlimited to remove a host limit.");
  button(form, `Create workspace on ${host}`, async () => {
    if (!form.reportValidity()) throw new Error("complete the workspace fields");
    /** @type {Record<string,string>} */ const resources = {};
    for (const field of [cpuCount, memory, pidsLimit]) if (field.value.trim()) resources[field.name] = field.value.trim();
    await request(`/v1/operations/hosts/${encodeURIComponent(host)}/workspaces/create`, {
      ...(repositories.value.trim() ? { repositories: repositories.value.split(",").map((id) => id.trim()) } : {}),
      ...(workingDirectory.value.trim() ? { workingDirectory: workingDirectory.value.trim() } : {}),
      source: source.value.trim(), name: name.value.trim(), runtime: runtime.value.trim(),
      ...(ref.value.trim() ? { ref: ref.value.trim() } : {}), ...(image.value.trim() ? { image: image.value.trim() } : {}),
      ...(Object.keys(resources).length ? { resources } : {})
    }, 300_000);
    await refresh();
  });
  form.addEventListener("submit", (event) => event.preventDefault());
}
/** @param {HTMLElement} parent @param {string} host @param {Record<string,unknown>} workspace @param {boolean} canOperate */
function renderWorkspace(parent, host, workspace, canOperate) {
  const name = text(workspace.name), expectedId = text(workspace.id); if (!name || !expectedId) return;
  const row = document.createElement("div"); row.className = "operations-row"; parent.append(row);
  const resources = record(workspace.resources);
  line(row, `${name} · ${text(workspace.runtime) ?? ""} · ${text(workspace.phase) ?? ""} / ${text(workspace.runtimeStatus) ?? ""}`);
  line(row, `CPU ${text(resources?.cpuCount) ?? ""}, memory ${text(resources?.memory) ?? ""}, PIDs ${text(resources?.pidsLimit) ?? ""}`);
  if (!canOperate) return;
  for (const action of ["start", "stop", "restart", "recreate", "discard"]) button(row, `${action} ${name}`, async () => {
    if (action === "discard" && !window.confirm(`Discard ${name} and its persistent data?`)) return;
    await request(`/v1/operations/hosts/${encodeURIComponent(host)}/workspaces`, { name, expectedId, action }); await refresh();
  });
  const form = document.createElement("form"); row.append(form);
  /** @type {Record<string,string>} */ const fields = {};
  for (const [key, label] of [["cpuCount", "CPUs"], ["memory", "Memory"], ["pidsLimit", "PIDs"]]) {
    if (!key || !label) continue;
    const field = document.createElement("label"), input = document.createElement("input"); field.textContent = `${label} `;
    input.value = text(resources?.[key]) ?? ""; input.name = key; input.setAttribute("aria-label", `${label} for ${name}`);
    input.addEventListener("input", () => { fields[key] = input.value; }); field.append(input); form.append(field);
  }
  button(form, `Apply resources for ${name}`, async () => { await request(`/v1/operations/hosts/${encodeURIComponent(host)}/workspaces`, { name, expectedId, action: "resources", resources: fields }); await refresh(); });
  form.addEventListener("submit", (event) => event.preventDefault());
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
