// @ts-check

/** @param {string} tag @param {string} [className] @param {string} [content] */
export function node(tag, className = "", content = "") {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = content;
  return element;
}

/** @param {string} label @param {string} [className] */
export function button(label, className = "button-secondary") {
  const control = document.createElement("button");
  control.type = "button";
  control.className = `button ${className}`;
  control.textContent = label;
  return control;
}

/** @param {HTMLElement} parent @param {string} name @param {string} label @param {string} scope @param {string} [value] */
export function input(parent, name, label, scope, value = "") {
  const field = node("label", "field"), caption = node("span", "", label), control = document.createElement("input");
  control.name = name;
  control.defaultValue = value;
  control.setAttribute("aria-label", `${label} ${scope}`);
  field.append(caption, control);
  parent.append(field);
  return control;
}

/** @param {HTMLElement} parent @param {string} label */
export function disclosure(parent, label) {
  const details = document.createElement("details"), summary = document.createElement("summary");
  summary.textContent = label;
  details.append(summary);
  parent.append(details);
  return details;
}

/** @param {HTMLElement} target @param {string} message @param {boolean} [error] */
export function feedback(target, message, error = false) {
  target.textContent = message;
  target.className = `workspace-feedback${error ? " is-error" : ""}`;
  target.setAttribute("role", error ? "alert" : "status");
}

/** @param {unknown} error */
export function isUnknownOutcome(error) {
  return error instanceof Error && "outcome" in error && error.outcome === "unknown";
}

/** @param {unknown} error */
export function failureCode(error) {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "";
}

/** @param {unknown} error */
export function requiresReconciliation(error) {
  return isUnknownOutcome(error) || failureCode(error) === "host_timeout";
}

/** @param {unknown} error */
export function recovery(error) {
  if (error instanceof Error && error.message === "session expired") return "Your session ended. Sign in again; this draft stays here until you leave.";
  if (error instanceof Error && "outcome" in error && error.outcome === "read") return "The current workspace list could not be read. Retry this host refresh; your drafts are kept.";
  /** @type {Record<string,string>} */ const guidance = {
    workspace_exists: "That name already exists. Check current state or choose another name. Your input is kept.",
    image_unavailable: "The workspace image is unavailable on this host. Choose an installed image under Advanced options, or ask the operator to build or pull the host default image. Your input is kept.",
    runtime_unavailable: "The selected host runtime is unavailable. Ask the operator to run dim doctor on that host and repair its runtime prerequisites. Your input is kept.",
    host_unavailable: "The configured DIM executable is unavailable. Ask the operator to repair the Web server's host connection. Your input is kept.",
    host_timeout: "The host did not answer in time. Check current state before deciding whether another mutation is safe. Your input is kept.",
    project_unavailable: "That managed project is not available on this host. Check the managed project connection, or enter an ordinary Git repository URL. Your input is kept.",
    ref_unavailable: "That Git ref was not found. Leave Git ref empty for the repository default, or enter an existing branch or commit. Your input is kept.",
    repository_unavailable: "The selected host could not access that repository. Check its URL and host Git credentials, or use another accessible repository. Your input is kept.",
    host_operation_failed: "The host rejected the operation. Ask the operator to inspect it with dim doctor. Your input is kept."
  };
  return guidance[failureCode(error)] ?? "The host rejected the operation. Check the input and retry. Your input is kept.";
}
