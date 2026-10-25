// @ts-check
import { mountManifestImport } from "./manifest.js";
import { mountAttachment } from "./attachment.js";
/** @typedef {{controllerId:string,projectId:string,repositoryId:string}} Target */
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebPluginBrowserContext} Context */
/** @typedef {{scope():Target,has(name:string):boolean,hostAuthority():boolean,refresh(preferred:{controllerId:string,projectId:string,repositoryId?:string}):Promise<void>}} Navigation */
/** @param {string} tag @param {string} [text] */
function element(tag, text = "") { const node = document.createElement(tag); node.textContent = text; return node; }
/** @param {HTMLFormElement} form @param {string} label @param {boolean} [required] */
function field(form, label, required = true) {
  const wrapper = element("label"), input = document.createElement("input"); wrapper.className = "field"; input.setAttribute("aria-label", label); input.required = required;
  wrapper.append(element("span", label), input); form.append(wrapper); return input;
}
/** @param {HTMLElement} container @param {Context} context @param {Navigation} navigation */
export function mountManagement(container, context, navigation) {
  const attachment = mountAttachment(container, context, navigation);
  const manifest = mountManifestImport(container, context, navigation);
  let disposed = false, activeController = "", activeProject = "";
  const current = () => !disposed && context.isCurrent();
  /** @param {Target} target */ const selected = (target) => current() && target.controllerId === navigation.scope().controllerId && target.projectId === navigation.scope().projectId;
  /** @type {Map<string,{id:string,message:string,accepted:boolean,pending:boolean}>} */ const creationDrafts = new Map();
  /** @type {Map<string,{id:string,url:string,branch:string,message:string,accepted:boolean,pending:boolean}>} */ const importDrafts = new Map();
  const createDetails = document.createElement("details"), importDetails = document.createElement("details");
  createDetails.className = importDetails.className = "panel"; createDetails.hidden = importDetails.hidden = true;
  createDetails.append(element("summary", "New project")); importDetails.append(element("summary", "Import repository"));
  const createForm = document.createElement("form"), importForm = document.createElement("form");
  createForm.setAttribute("aria-label", "New managed project"); importForm.setAttribute("aria-label", "Import public Git repository");
  createDetails.append(createForm); importDetails.append(importForm);
  const createId = field(createForm, "New project ID"), repositoryId = field(importForm, "New repository ID"), url = field(importForm, "Public HTTPS Git URL"), branch = field(importForm, "Branch (optional)", false);
  repositoryId.pattern = "[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?"; createId.pattern = "[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?"; createId.maxLength = 48; repositoryId.maxLength = 64;
  url.type = "url"; url.pattern = "https://.*"; url.maxLength = 4096; url.placeholder = "https://github.com/team/project.git";
  branch.maxLength = 512; branch.placeholder = "Remote default branch (HEAD)";
  importForm.append(element("p", "Import a public repository without credentials. The first imported repository becomes the project's default checkout. Repository .dim files do not automatically grant policy or execute host code."));
  const createSubmit = document.createElement("button"), importSubmit = document.createElement("button");
  createSubmit.type = importSubmit.type = "submit"; createSubmit.className = importSubmit.className = "button"; createSubmit.textContent = "Create project"; importSubmit.textContent = "Import repository";
  const createMessage = element("p"), importMessage = element("p"); createMessage.setAttribute("role", "status"); importMessage.setAttribute("role", "status");
  createForm.append(createSubmit, createMessage); importForm.append(importSubmit, importMessage); container.append(createDetails, importDetails);
  /** @param {string} controller @param {string} project */ const importKey = (controller, project) => JSON.stringify([controller, project]);
  function createDraft() { let draft = creationDrafts.get(activeController); if (!draft) { draft = { id: "", message: "", accepted: false, pending: false }; creationDrafts.set(activeController, draft); } return draft; }
  function importDraft() { const key = importKey(activeController, activeProject); let draft = importDrafts.get(key); if (!draft) { draft = { id: "", url: "", branch: "", message: "", accepted: false, pending: false }; importDrafts.set(key, draft); } return draft; }
  function paint() {
    if (!current()) return;
    const create = createDraft(), importing = importDraft();
    createDetails.hidden = !navigation.has("projects.create"); importDetails.hidden = !activeProject || !navigation.has("repositories.import");
    createId.value = create.id; repositoryId.value = importing.id; url.value = importing.url; branch.value = importing.branch;
    createMessage.textContent = create.message; importMessage.textContent = importing.message;
    createSubmit.disabled = create.pending || create.accepted; importSubmit.disabled = importing.pending || importing.accepted;
    createId.disabled = create.pending; for (const control of [repositoryId, url, branch]) control.disabled = importing.pending;
  }
  createId.addEventListener("input", () => { const draft = createDraft(); draft.id = createId.value; draft.accepted = false; createSubmit.disabled = draft.pending; });
  for (const control of [repositoryId, url, branch]) control.addEventListener("input", () => { const draft = importDraft(); draft.id = repositoryId.value; draft.url = url.value; draft.branch = branch.value; draft.accepted = false; importSubmit.disabled = draft.pending; });
  createForm.addEventListener("submit", async (event) => {
    event.preventDefault(); const target = navigation.scope(), draft = createDraft(); if (draft.pending || draft.accepted || !createForm.reportValidity()) return;
    const id = createId.value.trim(); draft.id = id; draft.pending = true; draft.message = `Creating ${id}…`; paint();
    try {
      await context.invoke("projects.create", { controllerId: target.controllerId, projectId: id });
      draft.accepted = true; draft.message = `Project ${id} created. Import its first repository to begin developing.`;
      if (selected(target)) {
        paint();
        try { await navigation.refresh({ controllerId: target.controllerId, projectId: id }); }
        catch { draft.message = `Project ${id} created. Latest project catalog could not refresh. Refresh projects to inspect it; the action was accepted.`; }
      }
    } catch (error) { draft.message = `Could not create ${id}: ${error instanceof Error ? error.message : "controller unavailable"}. Check the project ID before retrying.`; }
    finally { draft.pending = false; if (current() && navigation.scope().controllerId === target.controllerId) paint(); }
  });
  importForm.addEventListener("submit", async (event) => {
    event.preventDefault(); const target = navigation.scope(), draft = importDraft(); if (draft.pending || draft.accepted || !importForm.reportValidity()) return;
    const id = repositoryId.value.trim(), source = url.value.trim(), ref = branch.value.trim();
    draft.id = id; draft.url = source; draft.branch = ref; draft.pending = true; draft.message = `Importing ${target.projectId}/${id}… This can take a few minutes.`; paint();
    try {
      const result = /** @type {{projectId:string,repositoryId:string,protectedRef:string,commit:string,tree:string,projectReady:boolean}} */ (await context.invoke("repositories.import", { controllerId: target.controllerId, projectId: target.projectId, repositoryId: id, url: source, ...(ref ? { branch: ref } : {}) }, { timeoutMilliseconds: 185_000 }));
      if (result.projectId !== target.projectId || result.repositoryId !== id) throw new Error("Import receipt does not match the selected project and repository");
      draft.accepted = true; draft.message = `${target.projectId}/${id} imported at ${result.commit.slice(0, 12)} (${result.protectedRef}).`;
      if (selected(target)) {
        paint();
        try { await navigation.refresh({ controllerId: target.controllerId, projectId: target.projectId, repositoryId: id }); }
        catch { draft.message += " Latest project catalog could not refresh. Refresh projects to inspect it; the action was accepted."; }
      }
    } catch (error) { draft.message = `Could not import ${target.projectId}/${id}: ${error instanceof Error ? error.message : "controller unavailable"}. Check the public URL and branch before retrying; input is kept.`; }
    finally { draft.pending = false; if (selected(target)) paint(); }
  });
  return {
    update() { const target = navigation.scope(); activeController = target.controllerId; activeProject = target.projectId; attachment.update(); paint(); manifest.update(); },
    dispose() { disposed = true; attachment.dispose(); manifest.dispose(); }
  };
}
