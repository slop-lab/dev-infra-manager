// @ts-check
import { button, disclosure, failureCode, feedback, input, node, recovery, requiresReconciliation } from "./workspace-ui.js";
import {navigationRevision} from './navigation-broker.js';

/** @typedef {(path:string, body?:unknown, timeout?:number)=>Promise<unknown>} Request */

/** @param {{host:string,request:Request,refresh:()=>Promise<boolean>,active:()=>boolean,close:()=>void,workspaceId:(name:string)=>string|undefined,openWorkspace:(id:string)=>void}} options */
export function createWorkspaceForm(options) {
  const { host, request, refresh, active, close, workspaceId, openWorkspace } = options;
  const form = document.createElement("form");
  form.hidden = true;
  form.className = "workspace-create panel";
  form.setAttribute("aria-label", `New workspace on ${host}`);
  form.append(node("h3", "", "New workspace"), node("p", "field-hint", `Create an isolated development environment on ${host}. Enter a Git clone URL, or dim:// followed by a managed project ID already imported on this host.`));
  const availability = node('p', 'workspace-feedback'); availability.setAttribute('role', 'status'); form.append(availability);
  const basic = node("div", "workspace-fields");
  form.append(basic);
  const source = input(basic, "source", "Git URL or dim://PROJECT", `on ${host}`);
  source.type = "text";
  source.autocapitalize = "none";
  source.spellcheck = false;
  source.required = true;
  source.placeholder = "https://github.com/team/project.git";
  const sourceHelp = node("p", "field-hint", "Examples: https://github.com/octocat/Hello-World.git, git@github.com:team/project.git or dim://my-project. Private repositories use credentials configured on the selected host; keep passwords and tokens out of this field.");
  sourceHelp.id = `workspace-source-help-${host}`;
  source.setAttribute("aria-describedby", sourceHelp.id);
  basic.append(sourceHelp);
  const name = input(basic, "name", "Workspace name", `on ${host}`);
  name.required = true;
  name.pattern = "[a-z0-9][a-z0-9._\\-]{0,47}";
  name.placeholder = "my-project";
  name.maxLength = 48;
  name.title = "1-48 lowercase letters, digits, dots, underscores or hyphens; start with a letter or digit.";
  basic.append(node("p", "field-hint", "Choose a unique environment name on this host, for example my-project-dev."));
  const advanced = disclosure(form, "Advanced options");
  advanced.className = "workspace-advanced";
  const fields = node("div", "workspace-fields");
  advanced.append(fields);
  const ref = input(fields, "ref", "Git ref (optional)", `on ${host}`);
  ref.placeholder = "Repository default";
  const runtime = input(fields, "runtime", "Runtime", `on ${host}`, "container");
  runtime.required = true;
  runtime.pattern = "[a-z][a-z0-9\\-]{0,31}";
  fields.append(node("p", "field-hint", "Use container for the usual Docker workspace. vm requires the VM runtime and KVM on the host."));
  const image = input(fields, "image", "Image (optional)", `on ${host}`);
  image.placeholder = "Host default";
  const repositories = input(fields, "repositories", "Managed repositories (comma separated, optional)", `on ${host}`);
  const workingDirectory = input(fields, "workingDirectory", "Managed working repository (optional)", `on ${host}`);
  fields.append(node("p", "field-hint", "Managed repository selection applies only to dim://PROJECT sources."));
  const cpuCount = input(fields, "cpuCount", "CPU limit (optional)", `on ${host}`);
  const memory = input(fields, "memory", "Memory limit (optional)", `on ${host}`);
  const pidsLimit = input(fields, "pidsLimit", "PID limit (optional)", `on ${host}`);
  advanced.append(node("p", "field-hint", "Examples: CPUs 2 or 1.5, memory 4g, PIDs 2048. Empty uses the host default; unlimited removes a limit."));
  const result = node("p", "workspace-feedback");
  const actions = node("div", "workspace-actions"), submit = button("Create workspace", "button-primary"), replace = button("Replace draft with managed selection"), cancel = button("Cancel"), check = button("Check current state");
  submit.type = "submit";
  submit.setAttribute("aria-label", `Create workspace on ${host}`);
  cancel.setAttribute("aria-label", `Cancel new workspace on ${host}`);
  check.hidden = true; replace.hidden = true;
  actions.append(submit, replace, check, cancel);
  form.append(result, actions);
  let nameEdited = false, busy = false, blockedName = "", dirty = false, hostReady = false;
  /** @type {import("../plugin-api.js").WebManagedWorkspaceCreateTarget | null} */ let pendingPrefill = null;

  function updateSource() {
    const managed = source.value.trim().startsWith("dim://");
    for (const field of [repositories, workingDirectory]) {
      field.disabled = !managed;
      if (field.parentElement) field.parentElement.hidden = !managed;
    }
  }
  function updateGate() {
    const selectedName = name.value.trim(), exists = workspaceId(selectedName) !== undefined, blocked = blockedName !== "" && selectedName === blockedName;
    submit.disabled = busy || blocked || exists || !hostReady;
    availability.textContent = hostReady ? '' : `Host ${host} is unavailable or has not finished loading. You can prepare this draft, but creation is paused. Use Refresh or Retry host to check the connection; your input is kept.`;
    cancel.disabled = busy; replace.disabled = busy || blockedName !== "";
    for (const field of form.querySelectorAll("input")) field.disabled = busy;
    if (!busy) updateSource();
    check.hidden = !blocked;
    if (blocked) check.setAttribute("aria-label", `Check current state for ${blockedName}`);
    if (!blocked && selectedName && exists) feedback(result, `${selectedName} already exists in the current host state. Choose another name.`, true);
  }
  name.addEventListener("input", () => { dirty = true; nameEdited = true; updateGate(); });
  source.addEventListener("input", () => {
    dirty = true;
    updateSource();
    if (nameEdited) return;
    try {
      const url = new URL(source.value.trim());
      name.value = (url.protocol === "dim:" ? url.hostname : url.pathname.split("/").filter(Boolean).at(-1) ?? "")
        .replace(/\.git$/, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 48);
      updateGate();
    } catch {}
    if (!source.value.includes("://") && /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*:/.test(source.value.trim())) {
      name.value = (source.value.trim().split(":").slice(1).join(":").split("/").filter(Boolean).at(-1) ?? "")
        .replace(/\.git$/, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 48);
      updateGate();
    }
  });
  for (const field of [ref, runtime, image, repositories, workingDirectory, cpuCount, memory, pidsLimit]) field.addEventListener("input", () => { dirty = true; });
  replace.addEventListener("click", () => { if (pendingPrefill && !busy && blockedName === "") applyPrefill(pendingPrefill); });
  cancel.addEventListener("click", () => { form.hidden = true; close(); });
  check.addEventListener("click", () => { void (async () => {
    check.disabled = true;
    feedback(result, `Checking current state for ${blockedName} on ${host}...`);
    const loaded = await refresh();
    if (active()) {
      if (!loaded) feedback(result, `Current state for ${blockedName} could not be checked. Creation remains locked; retry Check current state. Your input is kept.`, true);
      else if (workspaceId(blockedName) !== undefined) feedback(result, `${blockedName} already exists in the current host state. This check does not establish which request created it. Choose another name to submit a new workspace.`, true);
      else { blockedName = ""; feedback(result, `${name.value.trim()} is not present in the current host state. Review the preserved input before retrying.`); }
    }
    check.disabled = false;
    updateGate();
  })(); });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || !hostReady || !form.reportValidity()) return;
    const selectedName = name.value.trim();
    if (blockedName !== "" && selectedName === blockedName) return;
    if (workspaceId(selectedName) !== undefined) { blockedName = selectedName; feedback(result, `${selectedName} already exists in the current host state. Choose another name.`, true); updateGate(); return; }
    /** @type {Record<string,string>} */ const resources = {};
    for (const field of [cpuCount, memory, pidsLimit]) if (field.value.trim()) resources[field.name] = field.value.trim();
    const payload = { source: source.value.trim(), name: selectedName, runtime: runtime.value.trim(),
      ...(source.value.trim().startsWith("dim://") && repositories.value.trim() ? { repositories: repositories.value.split(",").map((id) => id.trim()) } : {}),
      ...(source.value.trim().startsWith("dim://") && workingDirectory.value.trim() ? { workingDirectory: workingDirectory.value.trim() } : {}),
      ...(ref.value.trim() ? { ref: ref.value.trim() } : {}), ...(image.value.trim() ? { image: image.value.trim() } : {}),
      ...(Object.keys(resources).length ? { resources } : {}) };
    busy = true;
    const addressAtSubmit = window.location.href;
    const intentAtSubmit = navigationRevision();
    form.setAttribute("aria-busy", "true");
    updateGate();
    feedback(result, `Creating ${selectedName} on ${host}... This can take a few minutes.`);
    void (async () => {
      try {
        await request(`/v1/operations/hosts/${encodeURIComponent(host)}/workspaces/create`, payload, 300_000);
        if (!active()) return;
        const loaded = await refresh();
        if (!loaded) { blockedName = selectedName; feedback(result, `The create request for ${selectedName} was accepted, but current state could not be read. Do not submit it again. Check current state.`, true); }
        else if (workspaceId(selectedName) !== undefined) {
          const acceptedId = workspaceId(selectedName);
          form.reset(); nameEdited = false; dirty = false; pendingPrefill = null; replace.hidden = true; updateSource(); advanced.open = false; blockedName = "";
          feedback(result, `The host accepted ${selectedName}, and the workspace is listed below.`);
          if (acceptedId && addressAtSubmit === window.location.href && intentAtSubmit === navigationRevision()) openWorkspace(acceptedId);
        } else { blockedName = selectedName; feedback(result, `The host accepted the request, but ${selectedName} is not visible in the current state. Check current state before any retry.`, true); }
      } catch (error) {
        if (!active()) return;
        if (requiresReconciliation(error)) { blockedName = selectedName; feedback(result, `The create request for ${selectedName} did not return a reliable outcome, so the outcome is unknown. Do not submit it again. Check current state.`, true); }
        else { if (failureCode(error) === "workspace_exists") blockedName = selectedName; feedback(result, `Could not create ${selectedName} on ${host}. ${recovery(error)}`, true); }
      } finally { busy = false; form.removeAttribute("aria-busy"); updateSource(); updateGate(); }
    })();
  });
  /** @param {import("../plugin-api.js").WebManagedWorkspaceCreateTarget} target */
  function applyPrefill(target) {
    form.reset(); nameEdited = false; dirty = false;
    source.value = `dim://${target.projectId}`;
    repositories.value = target.repositoryIds.join(", ");
    workingDirectory.value = target.workingRepositoryId;
    runtime.value = "container";
    name.value = target.projectId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 48);
    pendingPrefill = null; replace.hidden = true; advanced.open = true; updateSource(); updateGate(); source.focus();
    feedback(result, `Managed project ${target.projectId} is ready for review. Creation has not been submitted.`);
  }
  /** @param {import("../plugin-api.js").WebManagedWorkspaceCreateTarget} target @returns {import("../plugin-api.js").WebNavigationResult} */
  function prefill(target) {
    form.hidden = false;
    if (busy || blockedName !== "") {
      source.focus();
      return { status: "blocked", message: "The current creation request must be reconciled before this draft can be replaced." };
    }
    if (dirty) {
      pendingPrefill = target; replace.hidden = false; replace.disabled = false; replace.focus();
      feedback(result, "This creation form has an edited draft. Replace it explicitly to use the managed project selection.", true);
      return { status: "blocked", message: "The existing workspace draft was kept. Use Replace draft with managed selection in the creation form." };
    }
    applyPrefill(target);
    return { status: "opened", message: `Opened a workspace draft for managed project ${target.projectId}.` };
  }
  updateSource();
  updateGate();
  return { form, source, updateGate, prefill, setHostReady(/** @type {boolean} */ ready) { hostReady = ready; updateGate(); } };
}
