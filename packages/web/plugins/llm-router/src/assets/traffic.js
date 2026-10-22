// @ts-check
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebPluginBrowserContext} Context */
/** @typedef {{ readonly input: string, readonly output: string }} ResolutionDraft */
/** @typedef {"execution"|"accounting"} ResolutionKind */
/** @typedef {{ readonly current: () => boolean }} TrafficOptions */
/** @typedef {{ readonly run: (button:HTMLButtonElement)=>Promise<void>, readonly feedback: HTMLElement }} ActionOptions */
/** @typedef {{ readonly feedback: HTMLElement, readonly receipt: string, readonly refresh: ()=>Promise<void> }} AcceptedOptions */

/** @param {unknown} value @returns {Record<string,unknown>} */
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string,unknown>} */ (value) : {}; }
/** @param {unknown} value @returns {Record<string,unknown>[]} */
function rows(value) { return Array.isArray(value) ? value.map(object) : []; }
/** @param {unknown} value */
function text(value) { return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "—"; }

/** @param {HTMLElement} container @param {Context} context @param {TrafficOptions} options */
export function mountTraffic(container, context, options) {
  const { element: node, input } = context.ui;
  const has = (/** @type {string} */ name) => context.operations.some((operation) => operation.name === name);
  /** @type {Map<string,ResolutionDraft>} */ const drafts = new Map();
  /** @type {Map<string,ResolutionKind>} */ const acceptedResolutions = new Map();
  /** @type {Map<string,{kind:ResolutionKind}>} */ const unknownResolutions = new Map();
  const traffic = node("section", "", "panel"), principals = node("section", "", "panel");
  const requestList = node("div"), principalList = node("div"), trafficStatus = node("p"), principalStatus = node("p"), trafficReceipt = node("p"), principalReceipt = node("p");
  for (const feedback of [trafficStatus, principalStatus, trafficReceipt, principalReceipt]) feedback.setAttribute("role", "status");
  traffic.append(node("h2", "Recent requests"), trafficStatus, trafficReceipt);
  const requestFilters = node("div", "", "workspace-filters");
  const requestSearch = input(requestFilters, "Find requests"), requestState = context.ui.select(requestFilters, "Request state", [{ value: "all", label: "All requests" }, { value: "active", label: "Active" }, { value: "unknown", label: "Unknown outcome" }]);
  requestSearch.placeholder = "Project, model, account or request ID";
  const requestEmpty = node("p", "No requests match these filters."); requestEmpty.hidden = true;
  traffic.append(requestFilters, requestList, requestEmpty);
  principals.append(node("h2", "Workspace access"), principalStatus, principalReceipt, principalList);
  container.append(traffic, principals);

  function filterRequests() {
    const query = requestSearch.value.trim().toLowerCase();
    let matches = 0;
    for (const row of requestList.querySelectorAll("article")) {
      row.hidden = !row.dataset.search?.includes(query) || requestState.value === "active" && row.dataset.active !== "true" || requestState.value === "unknown" && row.dataset.unknown !== "true";
      if (!row.hidden) matches++;
    }
    requestEmpty.hidden = matches !== 0 || requestList.querySelectorAll("article").length === 0;
  }
  requestSearch.addEventListener("input", filterRequests); requestState.addEventListener("change", filterRequests);

  /** @param {HTMLElement} parent @param {string} label @param {ActionOptions} options */
  function action(parent, label, options) {
    const button = context.ui.button(label);
    button.addEventListener("click", () => { if (button.disabled) return; button.disabled = true; button.dataset.pending = "true"; context.ui.feedback(options.feedback, `${label}…`);
      void options.run(button).catch((error) => context.ui.feedback(options.feedback, error instanceof Error ? error.message : "Operation failed. Refresh before retrying.", "error")).finally(() => { delete button.dataset.pending; button.disabled = button.dataset.accepted === "true"; }); });
    parent.append(button); return button;
  }
  /** @param {HTMLButtonElement} button @param {AcceptedOptions} acceptedOptions */
  async function accepted(button, acceptedOptions) {
    button.dataset.accepted = "true"; context.ui.feedback(acceptedOptions.feedback, acceptedOptions.receipt);
    try { await acceptedOptions.refresh(); }
    catch { if (options.current()) context.ui.feedback(acceptedOptions.feedback, `${acceptedOptions.receipt} Latest recent requests could not refresh. Use Refresh router to read the current state; the resolution was accepted.`); }
  }
  /** @param {HTMLElement} parent @param {string} projectId @param {HTMLElement} status */
  function projectNavigation(parent, projectId, status) {
    context.ui.navigationAction(parent, { label: `Open routing project ${projectId}`, status, isCurrent: options.current,
      open: () => context.navigation.openFeature("llm-router", { kind: "project", projectId }) });
  }
  /** @param {HTMLInputElement} inputTokens @param {HTMLInputElement} outputTokens */
  function observedUsage(inputTokens, outputTokens) {
    if (inputTokens.validity.badInput || outputTokens.validity.badInput) return { status: "invalid" };
    const inputValue = inputTokens.value.trim(), outputValue = outputTokens.value.trim();
    if (inputValue === "" && outputValue === "") return { status: "empty" };
    const inputCount = Number(inputValue), outputCount = Number(outputValue);
    if (inputValue === "" || outputValue === "" || !Number.isSafeInteger(inputCount) || inputCount < 0 || !Number.isSafeInteger(outputCount) || outputCount < 0) return { status: "invalid" };
    return { status: "observed", inputCount, outputCount };
  }
  /** @param {Record<string,unknown>} request @param {ResolutionKind} kind */
  function resolutionChanged(request, kind) { return kind === "execution" ? request.execution !== "outcome_unknown" : request.accounting !== "reconciliation_required"; }
  /** @param {boolean} [reconcileUnknown] */
  async function refreshRequests(reconcileUnknown = false) {
    const reconciling = reconcileUnknown ? new Map(unknownResolutions) : null;
    const requests = await context.invoke("requests", { limit: 100 }); if (!options.current()) return;
    requestList.replaceChildren(); trafficStatus.textContent = "";
    const requestRows = rows(requests); if (!requestRows.length) requestList.append(node("p", "No requests recorded yet."));
    for (const request of requestRows) {
      const id = text(request.id), projectId = text(request.project_id), row = node("article", "", "operations-row"), feedback = node("p"), navigationStatus = node("p");
      const acceptedKind = acceptedResolutions.get(id);
      if (acceptedKind && resolutionChanged(request, acceptedKind)) { acceptedResolutions.delete(id); drafts.delete(id); }
      const unknown = unknownResolutions.get(id);
      if (unknown && reconciling?.get(id) === unknown) { unknownResolutions.delete(id); if (resolutionChanged(request, unknown.kind)) drafts.delete(id); }
      feedback.setAttribute("role", "status"); navigationStatus.setAttribute("role", "status");
      row.dataset.search = [request.id, request.project_id, request.model, request.account_id].map(text).join(" ").toLowerCase();
      row.dataset.active = String(request.outcome === "running" || request.occupied === 1); row.dataset.unknown = String(request.execution === "outcome_unknown");
      row.append(node("h3", `${projectId} · ${text(request.model)}`), node("p", `${text(request.outcome)} · Execution ${text(request.execution)} · Usage ${text(request.accounting)}`), node("p", `Request ${id}`, "field-hint"), feedback, navigationStatus);
      projectNavigation(row, projectId, navigationStatus);
      const details = document.createElement("details"); details.append(node("summary", "Request metadata"));
      details.append(context.ui.table(["Field", "Value"], [["Account", request.account_id], ["Started", new Date(Number(request.started_at)).toLocaleString()], ["Finished", request.finished_at === null ? "Not finished" : new Date(Number(request.finished_at)).toLocaleString()], ["Delivery", request.delivery], ["Input tokens", request.input_tokens ?? "Unknown"], ["Output tokens", request.output_tokens ?? "Unknown"], ["Cancellation requested", request.cancel_requested ? "Yes" : "No"], ["Error code", request.error_code ?? "None"]].map((values) => values.map(text)))); row.append(details);
      if (has("request.cancel") && (request.outcome === "running" || request.occupied === 1)) action(row, `Request cancellation ${id.slice(0, 8)}`, { feedback, run: async () => { await context.invoke("request.cancel", { requestId: id }); if (options.current()) feedback.textContent = "Cancellation requested. Upstream termination is not confirmed; inspect the eventual outcome."; } });
      const resolutionKind = request.execution === "outcome_unknown" ? "execution" : request.accounting === "reconciliation_required" && request.outcome !== "running" ? "accounting" : undefined;
      if (has("request.resolve") && resolutionKind !== undefined) {
        if (acceptedResolutions.has(id)) row.append(node("p", "Resolution was accepted. Refresh current state before another mutation.", "field-hint"));
        else if (unknownResolutions.has(id)) row.append(node("p", "The resolution outcome is unknown. Use Refresh router to check authoritative request state before retrying.", "field-hint"));
        else {
          const form = document.createElement("form"); form.setAttribute("aria-label", resolutionKind === "execution" ? `Resolve request ${id}` : `Record observed usage for request ${id}`); row.append(form);
          const draft = drafts.get(id) ?? { input: "", output: "" };
          const inputTokens = input(form, "Observed input tokens", draft.input), outputTokens = input(form, "Observed output tokens", draft.output);
          for (const field of [inputTokens, outputTokens]) { field.type = "number"; field.min = "0"; field.step = "1"; field.placeholder = "Optional"; }
          const remember = () => drafts.set(id, { input: inputTokens.value, output: outputTokens.value }); inputTokens.addEventListener("input", remember); outputTokens.addEventListener("input", remember);
          form.append(node("p", resolutionKind === "execution" ? "Enter both observed nonnegative token counts, or leave both blank to retain unknown usage." : "Enter both observed nonnegative token counts to settle accounting without replaying inference.", "field-hint"));
          const label = resolutionKind === "execution" ? `Resolve unknown outcome ${id.slice(0, 8)}` : `Record observed usage ${id.slice(0, 8)}`;
          const submit = action(form, label, { feedback, run: async (button) => {
            const usage = observedUsage(inputTokens, outputTokens);
            if (usage.status === "invalid" || resolutionKind === "accounting" && usage.status === "empty") { context.ui.feedback(feedback, resolutionKind === "execution" ? "Enter both observed token counts, or leave both blank." : "Enter both observed token counts.", "error"); return; }
            const confirmation = resolutionKind === "accounting"
              ? `Record observed accounting for request ${id}: ${usage.status === "observed" ? usage.inputCount : 0} input tokens and ${usage.status === "observed" ? usage.outputCount : 0} output tokens? This does not replay inference.`
              : usage.status === "observed"
              ? `Resolve request ${id} with observed accounting of ${usage.inputCount} input tokens and ${usage.outputCount} output tokens? This does not replay inference.`
              : `Resolve request ${id} without observed token usage? Unknown token accounting remains unresolved and inference is not replayed.`;
            if (!window.confirm(confirmation)) { feedback.textContent = "No request was resolved."; return; }
            try { await context.invoke("request.resolve", usage.status === "observed" ? { requestId: id, usage: { inputTokens: usage.inputCount, outputTokens: usage.outputCount } } : { requestId: id }); }
            catch (error) {
              if (!(error instanceof Error && "outcome" in error && error.outcome === "unknown")) throw error;
              unknownResolutions.set(id, { kind: resolutionKind }); inputTokens.disabled = true; outputTokens.disabled = true; button.dataset.accepted = "true";
              context.ui.feedback(feedback, "The resolution outcome is unknown. Your draft is kept; use Refresh router to check authoritative request state before retrying.", "error"); return;
            }
            if (!options.current()) return;
            drafts.delete(id); acceptedResolutions.set(id, resolutionKind); inputTokens.value = ""; outputTokens.value = ""; feedback.textContent = "";
            const receipt = resolutionKind === "accounting" ? `Observed usage recorded for request ${id}.` : usage.status === "observed" ? `Resolution recorded with observed token usage for request ${id}.` : `Resolution recorded without observed token usage for request ${id}.`;
            await accepted(button, { feedback: trafficReceipt, receipt, refresh: refreshRequests });
          } });
          form.addEventListener("submit", (event) => { event.preventDefault(); submit.click(); });
        }
      } else { acceptedResolutions.delete(id); unknownResolutions.delete(id); drafts.delete(id); }
      requestList.append(row);
    }
    filterRequests();
  }
  async function refreshPrincipals() {
    const credentials = await context.invoke("principals"); if (!options.current()) return;
    principalList.replaceChildren(); principalStatus.textContent = "";
    const credentialRows = rows(credentials); if (!credentialRows.length) principalList.append(node("p", "No workspace principals issued yet."));
    for (const principal of credentialRows) {
      const row = node("article", "", "operations-row"), feedback = node("p"), navigationStatus = node("p"), projectId = text(principal.project_id);
      feedback.setAttribute("role", "status"); navigationStatus.setAttribute("role", "status");
      row.append(node("h3", `${text(principal.workspace_name)} · ${projectId}`), node("p", `Route ${text(principal.route_id)} · ${principal.enabled === 1 ? "Enabled" : "Revoked"}`), feedback, navigationStatus);
      projectNavigation(row, projectId, navigationStatus);
      if (has("principal.revoke") && principal.enabled === 1) action(row, `Revoke ${text(principal.workspace_name)}`, { feedback, run: async (button) => {
        if (!window.confirm(`Revoke ${text(principal.workspace_name)} access to ${projectId}? Reattachment requires host authorization.`)) { feedback.textContent = "No access was revoked."; return; }
        await context.invoke("principal.revoke", { principalId: text(principal.id) }); if (!options.current()) return;
        feedback.textContent = ""; button.dataset.accepted = "true";
        const receipt = `${text(principal.workspace_name)} access revoked.`; principalReceipt.textContent = receipt;
        try { await refreshPrincipals(); }
        catch { if (options.current()) principalReceipt.textContent = `${receipt} Latest workspace access could not refresh. Use Refresh router to read the current state; the change was accepted.`; }
      } });
      principalList.append(row);
    }
  }
  /** @param {boolean} [reconcileUnknown] */
  async function refresh(reconcileUnknown = false) {
    const results = await Promise.allSettled([refreshRequests(reconcileUnknown), refreshPrincipals()]); if (!options.current()) return false;
    for (const [index, feedback, label] of /** @type {Array<[number,HTMLElement,string]>} */ ([[0, trafficStatus, "Recent requests"], [1, principalStatus, "Workspace access"]])) {
      if (results[index]?.status === "rejected") context.ui.feedback(feedback, `${label} could not refresh. Previously loaded rows are kept; use Refresh router to retry this read.`, "error");
      else feedback.setAttribute("role", "status");
    }
    return results.every((result) => result.status === "fulfilled");
  }
  return { refresh, dispose() { drafts.clear(); acceptedResolutions.clear(); unknownResolutions.clear(); } };
}
