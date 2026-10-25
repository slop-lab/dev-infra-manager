// @ts-check
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebPluginBrowserContext} Context */
/** @typedef {{controllerId:string,projectId:string,repositoryId:string}} Scope */
/** @typedef {{projectId:string,repositoryCount:number}} DiscoveredProject */
/** @typedef {{repositoryId:string,defaultRef:string,branches?:string[]}} InspectedRepository */
/** @typedef {{projects:DiscoveredProject[]}} Discovery */
/** @typedef {{projectId:string,repositories:InspectedRepository[]}} Inspection */
/** @typedef {{scope():Scope,has(name:string):boolean,hostAuthority():boolean,refresh(preferred:{controllerId:string,projectId:string,repositoryId?:string}):Promise<void>}} Navigation */
/** @typedef {{projects:DiscoveredProject[],projectId:string,name:string,repositories:InspectedRepository[],configurationRepositoryId:string,defaultWorkingRepositoryId:string,message:string,pending:'discover'|'inspect'|'attach'|'',attached:boolean}} Draft */

/** @param {string} tag @param {string} [text] @param {string} [className] */
function element(tag, text = "", className = "") { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; }
/** @param {string} text @param {string} className */
function button(text, className) { const node = document.createElement("button"); node.type = "button"; node.textContent = text; node.className = className; return node; }
/** @param {HTMLElement} parent @param {string} label */
function select(parent, label) { const field = element("label", "", "field"), control = document.createElement("select"); control.setAttribute("aria-label", label); field.append(element("span", label), control); parent.append(field); return control; }
/** @param {HTMLSelectElement} control @param {readonly {value:string,label:string}[]} choices @param {string} selected */
function options(control, choices, selected) {
  control.replaceChildren();
  const prompt = document.createElement("option"); prompt.value = ""; prompt.textContent = "Select explicitly"; control.append(prompt);
  for (const choice of choices) { const option = document.createElement("option"); option.value = choice.value; option.textContent = choice.label; control.append(option); }
  control.value = choices.some(({ value }) => value === selected) ? selected : "";
}

/** @param {HTMLElement} container @param {Context} context @param {Navigation} navigation */
export function mountAttachment(container, context, navigation) {
  let disposed = false, activeController = "";
  /** @type {Map<string,Draft>} */ const drafts = new Map();
  const current = () => !disposed && context.isCurrent();
  const details = document.createElement("details"); details.className = "panel"; details.hidden = true; details.append(element("summary", "Attach existing project"));
  const form = document.createElement("form"); form.setAttribute("aria-label", "Attach existing managed project");
  form.append(element("p", "Discover Projects already owned by this controller authority, inspect their repositories, then choose both host defaults explicitly. Discovery never changes local state and attachment never reimports repositories."));
  const actions = element("div", "", "feature-actions"), discover = button("Discover available projects", "button button-secondary"); actions.append(discover); form.append(actions);
  const project = select(form, "Available project");
  const inspect = button("Inspect repositories", "button button-secondary"); form.append(inspect);
  const nameField = element("label", "", "field"), name = document.createElement("input"); name.setAttribute("aria-label", "Local project name (optional)"); name.maxLength = 48; name.pattern = "[a-z0-9][a-z0-9._-]{0,47}"; nameField.append(element("span", "Local project name (optional)"), name, element("span", "Leave empty to use the Project ID. A local collision is never replaced.", "field-hint")); form.append(nameField);
  const configuration = select(form, "Configuration repository"), working = select(form, "Default working repository");
  const submit = button("Attach project", "button button-primary"); submit.type = "submit";
  const message = element("p"); message.setAttribute("role", "status"); form.append(submit, message); details.append(form); container.append(details);

  function draft() {
    let value = drafts.get(activeController);
    if (!value) { value = { projects: [], projectId: "", name: "", repositories: [], configurationRepositoryId: "", defaultWorkingRepositoryId: "", message: "", pending: "", attached: false }; drafts.set(activeController, value); }
    return value;
  }
  function paint() {
    if (!current()) return;
    const value = draft(), repositoryChoices = value.repositories.map(({ repositoryId, defaultRef }) => ({ value: repositoryId, label: `${repositoryId} (${defaultRef})` }));
    details.hidden = !navigation.hostAuthority() || !navigation.has("projects.discover") || !navigation.has("projects.inspect") || !navigation.has("projects.attach");
    options(project, value.projects.map(({ projectId, repositoryCount }) => ({ value: projectId, label: `${projectId} (${repositoryCount} ${repositoryCount === 1 ? "repository" : "repositories"})` })), value.projectId);
    options(configuration, repositoryChoices, value.configurationRepositoryId); options(working, repositoryChoices, value.defaultWorkingRepositoryId);
    name.value = value.name; message.textContent = value.message;
    const busy = value.pending !== "";
    discover.disabled = busy; project.disabled = busy || value.projects.length === 0; inspect.disabled = busy || !value.projectId;
    name.disabled = configuration.disabled = working.disabled = busy || value.repositories.length === 0;
    submit.disabled = busy || value.attached || !value.projectId || !value.configurationRepositoryId || !value.defaultWorkingRepositoryId;
    form.setAttribute("aria-busy", String(busy));
  }
  project.addEventListener("change", () => { const value = draft(); value.projectId = project.value; value.repositories = []; value.configurationRepositoryId = ""; value.defaultWorkingRepositoryId = ""; value.attached = false; value.message = value.projectId ? "Inspect this Project before selecting host defaults." : ""; paint(); });
  name.addEventListener("input", () => { const value = draft(); value.name = name.value; value.attached = false; paint(); });
  configuration.addEventListener("change", () => { const value = draft(); value.configurationRepositoryId = configuration.value; value.attached = false; paint(); });
  working.addEventListener("change", () => { const value = draft(); value.defaultWorkingRepositoryId = working.value; value.attached = false; paint(); });
  discover.addEventListener("click", () => { void (async () => {
    const controllerId = activeController, value = draft(); if (value.pending) return; value.pending = "discover"; value.message = "Discovering available Projects…"; paint();
    try {
      const result = /** @type {Discovery} */ (await context.invoke("projects.discover", { controllerId }));
      if (!current() || activeController !== controllerId) return;
      value.projects = result.projects;
      if (value.projectId && !result.projects.some(({ projectId }) => projectId === value.projectId)) value.message = "The previously selected Project is no longer available. Your local name and repository choices are kept for reference; select another Project to continue.";
      else value.message = result.projects.length ? "Select a Project, then inspect its repository choices." : "No unattached Projects are available from this controller authority.";
    } catch (error) { value.message = `Could not discover Projects: ${error instanceof Error ? error.message : "controller unavailable"}. Your selection is kept; retry discovery.`; }
    finally { value.pending = ""; if (current() && activeController === controllerId) paint(); }
  })(); });
  inspect.addEventListener("click", () => { void (async () => {
    const controllerId = activeController, value = draft(), projectId = value.projectId; if (value.pending || !projectId) return; value.pending = "inspect"; value.message = `Inspecting ${projectId} repositories…`; paint();
    try {
      const result = /** @type {Inspection} */ (await context.invoke("projects.inspect", { controllerId, projectId }));
      if (!current() || activeController !== controllerId || value.projectId !== projectId) return;
      if (result.projectId !== projectId) throw new Error("Inspection does not match the selected Project");
      value.repositories = result.repositories;
      const repositoryIds = new Set(result.repositories.map(({ repositoryId }) => repositoryId));
      if (!repositoryIds.has(value.configurationRepositoryId)) value.configurationRepositoryId = "";
      if (!repositoryIds.has(value.defaultWorkingRepositoryId)) value.defaultWorkingRepositoryId = "";
      value.message = result.repositories.length ? "Choose the configuration and default working repositories explicitly. They may be the same." : "This Project has no ready repositories and cannot be attached.";
    } catch (error) { value.message = `Could not inspect ${projectId}: ${error instanceof Error ? error.message : "controller unavailable"}. Your choices are kept; retry inspection.`; }
    finally { value.pending = ""; if (current() && activeController === controllerId) paint(); }
  })(); });
  form.addEventListener("submit", (event) => { event.preventDefault(); void (async () => {
    const controllerId = activeController, value = draft(), projectId = value.projectId; if (value.pending || value.attached || !form.reportValidity() || !projectId || !value.configurationRepositoryId || !value.defaultWorkingRepositoryId) return;
    const configurationRepositoryId = value.configurationRepositoryId, defaultWorkingRepositoryId = value.defaultWorkingRepositoryId, localName = value.name.trim();
    value.pending = "attach"; value.message = `Attaching ${projectId} to this host…`; paint();
    try {
      await context.invoke("projects.attach", { controllerId, projectId, ...(localName ? { name: localName } : {}), configurationRepositoryId, defaultWorkingRepositoryId });
      value.attached = true; value.message = `${projectId} attached. Refreshing the local Project selector…`;
      if (!current() || activeController !== controllerId) return;
      paint();
      try { await navigation.refresh({ controllerId, projectId, repositoryId: defaultWorkingRepositoryId }); }
      catch { value.message = `${projectId} was attached, but the local Project selector could not refresh. Do not attach again; use Refresh projects to inspect the existing local state.`; }
    } catch (error) {
      const reason = (error instanceof Error ? error.message : "controller unavailable").replace(/[.!?]+$/, "");
      value.message = `Could not attach ${projectId}: ${reason}. Existing local state was not replaced and no source was reimported. Refresh projects to inspect current state or review the preserved choices before retrying.`;
    } finally { value.pending = ""; if (current() && activeController === controllerId) paint(); }
  })(); });
  return { update() { activeController = navigation.scope().controllerId; paint(); }, dispose() { disposed = true; } };
}
