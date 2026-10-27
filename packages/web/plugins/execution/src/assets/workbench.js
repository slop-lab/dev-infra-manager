// @ts-check
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebPluginUi} Ui */
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebPluginLocation} Location */

export function attachExecutionStyles() {
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = new URL("./execution.css", import.meta.url).href;
  document.head.append(stylesheet);
  return () => stylesheet.remove();
}

/** @param {Location|undefined} location @param {readonly string[]} prefix */
export function scopedExecutionLocation(location, prefix) {
  if (!location || !prefix.length) return location;
  const matches = (/** @type {readonly string[]} */ path) => prefix.every((part, index) => path[index] === part);
  /** @type {Location} */
  const scoped = {
    get revision() { return location.revision; },
    get path() { return matches(location.path) ? location.path.slice(prefix.length) : []; },
    href(path) { return location.href([...prefix, ...path]); },
    navigate(path, options) { location.navigate([...prefix, ...path], options); },
    subscribe(handler) { return location.subscribe((path) => { if (matches(path)) handler(path.slice(prefix.length)); }); }
  };
  return scoped;
}

/** @param {Ui} ui @param {Location|undefined} location */
export function createExecutionWorkbench(ui, location) {
  const toolbar = ui.element("div", "", "feature-actions"), filters = ui.element("div", "", "execution-filters"), status = ui.element("p"), filterContext = ui.element("div");
  const jobsView = ui.element("section", "", "execution-section"), jobs = ui.element("div", "", "execution-card"), detail = ui.element("article", "", "execution-card");
  const capacityView = ui.element("section", "", "execution-section"), capacity = ui.element("div", "", "execution-card"), launchView = ui.element("section", "", "execution-section"), unavailable = ui.element('section', '', 'execution-section');
  unavailable.append(ui.element('h2', 'Execution task unavailable'), ui.element('p', 'This execution task location is invalid. Choose Jobs, Workers or Launch & ownership; no task was submitted.'));
  const search = ui.input(filters, "Search jobs"), state = ui.select(filters, "Job state", [
    { value: "", label: "All states" }, { value: "queued", label: "Queued" }, { value: "assigned", label: "Assigned" },
    { value: "running", label: "Running" }, { value: "recovering", label: "Recovering" }, { value: "finished", label: "Finished" }
  ]);
  search.placeholder = "Job, ID, project or repository";
  const sectionNav = ui.element("nav", "", "execution-sections"); sectionNav.setAttribute("aria-label", "Execution sections");
  const links = [{ path: "jobs", label: "Jobs" }, { path: "workers", label: "Workers" }, { path: "launch", label: "Launch & ownership" }].map(({ path, label }) => {
    const link = ui.element("a", label); link.href = location?.href([path]) ?? `#execution-${path}`; link.dataset.section = path; sectionNav.append(link); return link;
  });
  const jobsHeading = ui.element("div", "", "execution-section-heading"), jobsCopy = ui.element("div"); jobsCopy.append(ui.element("p", "Queue and results", "eyebrow"), ui.element("h2", "Execution jobs"), ui.element("p", "Inspect scheduler state, completed results and bounded output without changing the queue.", "execution-muted")); jobsHeading.append(jobsCopy, toolbar); jobsView.append(jobsHeading, filters, filterContext, status, jobs, detail);
  const capacityHeading = ui.element("div", "", "execution-section-heading"), capacityCopy = ui.element("div"); capacityCopy.append(ui.element("p", "Scheduler discovery", "eyebrow"), ui.element("h2", "Worker capacity"), ui.element("p", "Configured slots and observed worker connectivity are separate signals.", "execution-muted")); capacityHeading.append(capacityCopy); capacityView.append(capacityHeading, capacity);
  const launch = ui.element("div", "", "execution-card execution-launch-boundary"); launch.append(ui.element("p", "Task producers", "eyebrow"), ui.element("h2", "Launch & ownership"), ui.element("p", "Execution launch belongs to installed task producers. This console does not expose an arbitrary command or generic task submission operation."));
  const launchSteps = ui.element("ol"); launchSteps.append(ui.element("li", "Choose the owning integration, such as a review detector or another installed producer."), ui.element("li", "That producer submits a typed task and owns its input, authorization and recovery."), ui.element("li", "Return here to inspect shared worker capacity and any CI jobs exposed by the query contract.")); launch.append(launchSteps, ui.element("p", "Generic task slots appear under Workers with their task type and execution kind. Their logs, results and artifacts remain with the producer unless it publishes a browser-safe operation.", "field-hint")); launchView.append(launch);
  /** @param {string} path */
  function paintSection(path) { const section = ['jobs','workers','launch'].includes(path) ? path : 'unavailable'; jobsView.hidden = section !== "jobs"; capacityView.hidden = section !== "workers"; launchView.hidden = section !== "launch"; unavailable.hidden = section !== 'unavailable'; for (const link of links) link.setAttribute("aria-current", link.dataset.section === section ? 'page' : 'false'); return section; }
  /** @param {string} path @param {boolean} [replace] */
  function showSection(path, replace = false) { const section = paintSection(path); if (location && (location.path.length !== 1 || location.path[0] !== section || replace)) location.navigate([section], { replace }); }
  for (const link of links) link.addEventListener("click", (event) => {
    if (!location || !(event instanceof MouseEvent) || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault(); showSection(link.dataset.section ?? "jobs");
  });
  return { root: [sectionNav, jobsView, capacityView, launchView, unavailable], toolbar, filters, status, filterContext, jobs, detail, capacity, search, state, paintSection, showSection };
}
