// @ts-check
/** @typedef {import('./management.js').Target} Target */
/** @typedef {import('./management.js').Context} Context */
/** @typedef {import('./management.js').Navigation} Navigation */
/** @typedef {{manifest:string,message:string,pending:boolean,accepted:boolean,preview?:{projectId:string,repositories:Array<{repositoryId:string,url:string,branch:string,protectedRef:string}>,configurationRepositoryId:string,defaultWorkingRepositoryId:string},previewSource?:string}} Draft */
/** @param {string} tag @param {string} [text] */
function element(tag, text = "") { const node = document.createElement(tag); node.textContent = text; return node; }
/** @param {HTMLElement} container @param {Context} context @param {Navigation} navigation */
export function mountManifestImport(container, context, navigation) {
  let disposed = false;
  /** @type {Map<string,Draft>} */ const drafts = new Map();
  const current = () => !disposed && context.isCurrent();
  /** @param {Target} target */ const key = (target) => JSON.stringify([target.controllerId, target.projectId]);
  /** @param {Target} target */ function draftFor(target) { const id = key(target); let draft = drafts.get(id); if (!draft) { draft = { manifest: "", message: "", pending: false, accepted: false }; drafts.set(id, draft); } return draft; }
  /** @param {Target} target */ const selected = (target) => current() && key(target) === key(navigation.scope());
  const details = document.createElement("details"); details.className = "panel"; details.hidden = true; details.append(element("summary", "Import .dim/repos.yml"));
  const form = document.createElement("form"); form.setAttribute("aria-label", "Import repository manifest");
  form.append(element("p", "Paste or select .dim/repos.yml, then inspect the repository and policy preview. Import explicitly accepts the manifest's repository configuration and review policy; repository scripts are never run."));
  const fileLabel = element("label"), file = document.createElement("input"); file.type = "file"; file.accept = ".yml,.yaml,text/yaml,text/plain"; file.setAttribute("aria-label", "Select repos.yml file"); fileLabel.className = "field"; fileLabel.append(element("span", "Select repos.yml file (optional)"), file);
  const label = element("label"), input = document.createElement("textarea"); label.className = "field"; input.setAttribute("aria-label", ".dim/repos.yml contents"); input.required = true; input.maxLength = 65_536; input.rows = 12; input.spellcheck = false; label.append(element("span", ".dim/repos.yml contents"), input);
  const previewButton = document.createElement("button"), submit = document.createElement("button"); previewButton.type = "submit"; previewButton.className = "button button-secondary"; previewButton.textContent = "Preview manifest"; submit.type = "button"; submit.className = "button"; submit.textContent = "Import manifest repositories";
  const previewRegion = element("section"), message = element("p"); message.setAttribute("role", "status"); previewRegion.setAttribute("aria-label", "Repository manifest preview");
  form.append(fileLabel, label, previewButton, previewRegion, submit, message); details.append(form); container.append(details);
  function paint() {
    if (!current()) return;
    const target = navigation.scope(), draft = draftFor(target);
    details.hidden = !target.projectId || !navigation.has("repositories.preview-manifest") || !navigation.has("repositories.import-manifest");
    input.value = draft.manifest; input.disabled = file.disabled = draft.pending; previewButton.disabled = draft.pending || draft.accepted;
    submit.hidden = !draft.preview; submit.disabled = draft.pending || draft.accepted || draft.previewSource !== draft.manifest; message.textContent = draft.message;
    previewRegion.replaceChildren();
    if (draft.preview) {
      previewRegion.append(element("h4", "Repositories to import"));
      const list = element("ul"); for (const repo of draft.preview.repositories) list.append(element("li", `${repo.repositoryId}: ${repo.url} (${repo.branch} → ${repo.protectedRef})`));
      previewRegion.append(list, element("p", `Configuration repository: ${draft.preview.configurationRepositoryId}. Default checkout: ${draft.preview.defaultWorkingRepositoryId}.`));
      const policy = document.createElement("details"); policy.append(element("summary", "Complete import configuration and policy"), element("pre", JSON.stringify(draft.preview, null, 2))); previewRegion.append(policy);
    }
  }
  input.addEventListener("input", () => { const draft = draftFor(navigation.scope()); draft.manifest = input.value; draft.accepted = false; delete draft.preview; delete draft.previewSource; draft.message = "Preview the updated manifest before importing."; paint(); });
  file.addEventListener("change", async () => {
    const target = navigation.scope(), draft = draftFor(target), selectedFile = file.files?.[0]; if (!selectedFile || draft.pending) return;
    try { if (selectedFile.size > 65_536) throw new Error("Manifest exceeds 64 KiB"); const contents = await selectedFile.text(); if (!selected(target)) return; draft.manifest = contents; draft.accepted = false; delete draft.preview; delete draft.previewSource; draft.message = "File loaded. Preview the manifest before importing."; }
    catch (error) { draft.message = error instanceof Error ? error.message : "Could not read the selected file"; }
    finally { file.value = ""; if (selected(target)) paint(); }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); const target = navigation.scope(), draft = draftFor(target); if (draft.pending || draft.accepted || !form.reportValidity()) return;
    const manifest = input.value; draft.manifest = manifest; draft.pending = true; draft.message = "Checking manifest…"; delete draft.preview; delete draft.previewSource; paint();
    try {
      const preview = /** @type {NonNullable<Draft['preview']>} */ (await context.invoke("repositories.preview-manifest", { controllerId: target.controllerId, projectId: target.projectId, manifest }));
      if (preview.projectId !== target.projectId) throw new Error("Preview does not match the selected project");
      draft.preview = preview; draft.previewSource = manifest; draft.message = "Inspect the repositories, checkout and policy above, then import this manifest.";
    } catch (error) { draft.message = `Could not preview manifest: ${error instanceof Error ? error.message : "controller unavailable"}. Input is kept.`; }
    finally { draft.pending = false; if (selected(target)) paint(); }
  });
  submit.addEventListener("click", async () => {
    const target = navigation.scope(), draft = draftFor(target); if (draft.pending || draft.accepted || !draft.preview || draft.previewSource !== draft.manifest) return;
    const preview = draft.preview, manifest = draft.manifest; draft.pending = true; draft.message = "Importing manifest repositories… This can take a few minutes."; paint();
    try {
      const result = /** @type {{projectId:string,repositories:Array<{repositoryId:string,commit:string}>}} */ (await context.invoke("repositories.import-manifest", { controllerId: target.controllerId, projectId: target.projectId, manifest }, { timeoutMilliseconds: 185_000 }));
      if (result.projectId !== target.projectId) throw new Error("Import receipt does not match the selected project");
      draft.accepted = true; draft.message = `Manifest imported: ${result.repositories.map((repo) => `${repo.repositoryId} at ${repo.commit.slice(0, 12)}`).join(", ")}.`;
      if (selected(target)) {
        paint();
        try { await navigation.refresh({ ...target, repositoryId: preview.defaultWorkingRepositoryId }); }
        catch { draft.message += " Latest project catalog could not refresh. Refresh projects to inspect it; the action was accepted."; }
      }
    } catch (error) { draft.message = `Could not import manifest: ${error instanceof Error ? error.message : "controller unavailable"}. Input is kept; retry the same manifest to resume any completed imports.`; }
    finally { draft.pending = false; if (selected(target)) paint(); }
  });
  return { update: paint, dispose() { disposed = true; } };
}
