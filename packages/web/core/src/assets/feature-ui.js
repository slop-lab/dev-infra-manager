// @ts-check

/** @type {import("../plugin-api.js").WebPluginUi["element"]} */
function element(tag, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

/** @type {import("../plugin-api.js").WebPluginUi["button"]} */
function button(label, variant = "secondary") {
  const control = document.createElement("button");
  control.type = "button";
  control.className = `button button-${variant}`;
  control.textContent = label;
  return control;
}

/** @type {import("../plugin-api.js").WebPluginUi["input"]} */
function input(parent, label, value = "") {
  const field = element("label", "", "field");
  const control = document.createElement("input");
  control.value = value;
  control.setAttribute("aria-label", label);
  field.append(element("span", label), control);
  parent.append(field);
  return control;
}

/** @type {import("../plugin-api.js").WebPluginUi["select"]} */
function select(parent, label, choices, value) {
  const field = element("label", "", "field");
  const control = document.createElement("select");
  control.setAttribute("aria-label", label);
  for (const choice of choices) {
    const option = document.createElement("option");
    option.value = choice.value;
    option.textContent = choice.label;
    control.append(option);
  }
  if (value !== undefined) control.value = value;
  field.append(element("span", label), control);
  parent.append(field);
  return control;
}

/** @type {import("../plugin-api.js").WebPluginUi["feedback"]} */
function feedback(target, text, tone = "status") {
  target.textContent = text;
  target.className = `workspace-feedback${tone === "error" ? " is-error" : ""}`;
  target.setAttribute("role", tone === "error" ? "alert" : "status");
}

/** @type {import("../plugin-api.js").WebPluginUi["table"]} */
function table(headings, rows) {
  const wrapper = element("div", "", "feature-table");
  const control = document.createElement("table");
  const head = document.createElement("thead"), header = document.createElement("tr");
  for (const heading of headings) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = heading;
    header.append(cell);
  }
  head.append(header);
  const body = document.createElement("tbody");
  for (const values of rows) {
    const row = document.createElement("tr");
    for (const value of values) row.append(element("td", value));
    body.append(row);
  }
  control.append(head, body);
  wrapper.append(control);
  return wrapper;
}

/** @type {import("../plugin-api.js").WebPluginUi["navigationAction"]} */
function navigationAction(parent, options) {
  const control = button(options.label), label = element("span", options.label), spinner = element("span", "", "spinner");
  spinner.setAttribute("aria-hidden", "true");
  control.replaceChildren(spinner, label);
  let revision = 0;
  control.addEventListener("click", () => {
    if (control.disabled || !options.isCurrent()) return;
    const selected = ++revision, statusRevision = (navigationStatusRevisions.get(options.status) ?? 0) + 1;
    navigationStatusRevisions.set(options.status, statusRevision);
    control.disabled = true; control.classList.add("is-loading"); control.setAttribute("aria-busy", "true");
    feedback(options.status, "Opening destination");
    void options.open().then((result) => {
      if (selected !== revision || navigationStatusRevisions.get(options.status) !== statusRevision || !options.isCurrent()) return;
      feedback(options.status, result.message, result.status === "unavailable" ? "error" : "status");
    }).catch(() => {
      if (selected === revision && navigationStatusRevisions.get(options.status) === statusRevision && options.isCurrent()) feedback(options.status, "The destination could not be opened. Retry navigation; your input is kept.", "error");
    }).finally(() => {
      if (selected !== revision || !options.isCurrent()) return;
      control.disabled = false; control.classList.remove("is-loading"); control.removeAttribute("aria-busy");
    });
  });
  parent.append(control);
  return control;
}

/** @type {WeakMap<HTMLElement,number>} */
const navigationStatusRevisions = new WeakMap();

/** @type {import("../plugin-api.js").WebPluginUi} */
export const featureUi = Object.freeze({ element, button, input, select, feedback, table, navigationAction });
