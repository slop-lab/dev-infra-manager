// @ts-check
import { mountManagement } from "./management.js";
/** @typedef {{name:string,description:string,access:string}} Descriptor */
/** @typedef {{operations:Descriptor[],invoke(name:string,input?:unknown,options?:{timeoutMilliseconds:number}):Promise<unknown>,isCurrent():boolean}} Context */
/** @typedef {import('@slop-lab/dim-native-git-client').ReviewDto} Review */
/** @typedef {{controllerId:string,projectId:string,repositoryId:string}} Scope */
/** @typedef {{id:string,title:string,status:'ready'|'unavailable',reviewerId?:string,projects:Array<{projectId:string,name:string,repositoryIds:string[]}>,operations:Descriptor[]}} Controller */
/** @param {string} tag @param {string} [text] */
function element(tag, text = "") { const node = document.createElement(tag); node.textContent = text; return node; }
/** @param {HTMLElement} container @param {Context} context */
export function mount(container, context) {
  let disposed = false, catalogVersion = 0, listVersion = 0, detailVersion = 0, formVersion = 0;
  /** @type {Controller[]} */ let controllers = [];
  /** @type {Map<string,string>} */ const drafts = new Map();
  const current = () => !disposed && context.isCurrent();
  const permitted = new Set(context.operations.map(({ name }) => name));
  const status = element("p"); status.setAttribute("role", "status");
  const managementRegion = element("div");
  const availability = element("div"), selectors = element("div"), toolbar = element("div"), actions = element("div"), list = element("section"), detail = element("section"), syncStatus = element("section");
  toolbar.className = actions.className = "feature-actions";
  /** @param {string} label */
  function selector(label) { const field = element("label"), name = element("span", label), control = document.createElement("select"); field.className = "field"; control.setAttribute("aria-label", label); field.append(name, control); selectors.append(field); return { field, control }; }
  const host = selector("Controller"), project = selector("Project"), repository = selector("Repository");
  const form = document.createElement("form"), proposal = document.createElement("input"), submit = document.createElement("button"), proposalLabel = element("label");
  proposalLabel.className = "field"; proposal.setAttribute("aria-label", "Proposal ref"); proposal.required = true; proposal.maxLength = 1024; proposal.placeholder = "refs/dim/proposals/…";
  proposalLabel.append(element("span", "Proposal ref"), proposal); submit.type = "submit"; submit.className = "button"; submit.textContent = "Resolve proposal review"; form.append(proposalLabel, submit);
  container.append(element("p", "Select a controller, project and repository to inspect exact review evidence."), toolbar, availability, selectors, managementRegion, actions, status, form, syncStatus, list, detail);
  /** @returns {Scope} */ const scope = () => ({ controllerId: host.control.value, projectId: project.control.value, repositoryId: repository.control.value });
  /** @param {Scope} value */ const key = (value) => JSON.stringify([value.controllerId, value.projectId, value.repositoryId]);
  /** @param {Scope} value */ const selected = (value) => current() && key(value) === key(scope());
  const controller = () => controllers.find(({ id }) => id === host.control.value);
  /** @param {string} name */ const has = (name) => permitted.has(name) && Boolean(controller()?.operations.some((operation) => operation.name === name));
  /** @param {Scope} target @param {string} name @param {Record<string,unknown>} [input] */
  const invoke = (target, name, input = {}) => context.invoke(name, { ...target, ...input });
  const management = mountManagement(managementRegion, context, { scope, has, refresh: (preferred) => refreshCatalog(preferred) });
  let draftKey = "";
  function saveDraft() { if (draftKey) drafts.set(draftKey, proposal.value); }
  function restoreDraft() { draftKey = key(scope()); proposal.value = drafts.get(draftKey) ?? ""; delete submit.dataset.accepted; submit.disabled = false; }
  /** @param {HTMLElement} parent @param {string} title @param {(button:HTMLButtonElement,target:Scope)=>Promise<boolean|void>} action */
  function button(parent, title, action) {
    const node = document.createElement("button"); node.type = "button"; node.className = "button button-secondary"; node.textContent = title;
    node.addEventListener("click", async () => {
      if (node.disabled) return; const target = scope(); node.disabled = true; status.textContent = `${title}…`;
      try { const result = await action(node, target); if (selected(target) && result !== false) status.textContent = `${title} completed.`; }
      catch (error) { if (selected(target)) status.textContent = `${title} failed: ${error instanceof Error ? error.message : "service unavailable"}. Refresh the review before trying again.`; }
      finally { if (current()) node.disabled = node.dataset.accepted === "true"; }
    }); parent.append(node); return node;
  }
  /** @param {HTMLButtonElement} button @param {Scope} target @param {string} receipt @param {Array<[string,()=>Promise<unknown>]>} reads @param {boolean} [lock] */
  async function accepted(button, target, receipt, reads, lock = true) {
    if (lock) button.dataset.accepted = "true";
    if (!selected(target)) return false;
    status.textContent = receipt;
    const results = await Promise.allSettled(reads.map(([, read]) => read()));
    if (selected(target)) { const failed = reads.filter((_, index) => results[index]?.status === "rejected").map(([name]) => name); status.textContent = failed.length ? `${receipt} Latest ${failed.join(" and ")} could not refresh. Refresh this view to inspect current state; the action was accepted.` : receipt; }
    return false;
  }
  /** @param {Review} review @param {Scope} target */
  function showReview(review, target) {
    if (!selected(target)) return;
    if (review.projectId !== target.projectId || review.repositoryId !== target.repositoryId) throw new Error("Review evidence belongs to a different project or repository");
    const reviewerId = controller()?.reviewerId;
    detail.replaceChildren(element("h3", `Review ${review.reviewId.slice(0, 12)} — ${review.status}`));
    const evidence = element("dl");
    for (const [label, value] of [["Project / repository", `${review.projectId}/${review.repositoryId}`], ["Proposal", review.proposalRef], ["Protected ref", review.protectedRef], ["Current protected commit", review.expectedProtectedHead], ["Candidate commit", review.candidateCommit], ["Candidate tree", review.candidateTree], ["Policy revision", review.policyRevision], ["Required reviewers", review.requiredReviewerIds.join(", ") || "None"], ["Stale reasons", review.staleReasons.join("; ") || "None"]]) evidence.append(element("dt", label), element("dd", value));
    detail.append(evidence, element("h4", "Changed files"));
    const changes = element("ul"); for (const change of review.changes) changes.append(element("li", `${change.status}: ${change.oldPath ?? ""}${change.oldPath && change.newPath && change.oldPath !== change.newPath ? " → " : ""}${change.newPath && change.newPath !== change.oldPath ? change.newPath : ""}`)); detail.append(changes);
    const diff = document.createElement("details"); diff.append(element("summary", `Patch (${review.patch.length.toLocaleString()} characters)`), element("pre", review.patch || "No textual changes.")); detail.append(diff, element("h4", "Approvals"));
    const approvals = element("ul");
    for (const approval of review.approvals) {
      const revoked = review.revocations.some((revocation) => revocation.approvalId === approval.approvalId), row = element("li", `${approval.reviewerId} — ${new Date(approval.approvedAt).toLocaleString()}${revoked ? " (revoked)" : ""}`);
      if (!revoked && approval.reviewerId === reviewerId && has("reviews.revoke")) button(row, `Revoke ${approval.reviewerId} approval`, async (button) => {
        if (!window.confirm(`Revoke approval ${approval.approvalId.slice(0, 12)} from ${approval.reviewerId}?`)) { status.textContent = "Revocation dismissed."; return false; }
        const value = /** @type {Review} */ (await invoke(target, "reviews.revoke", { reviewId: review.reviewId, approvalId: approval.approvalId })); showReview(value, target);
        return accepted(button, target, "Approval revoked.", [["review list", () => refreshList(target)]]);
      }); approvals.append(row);
    }
    if (!review.approvals.length) approvals.append(element("li", "No approvals recorded.")); detail.append(approvals);
    if (reviewerId && has("reviews.approve") && review.status !== "stale" && review.requiredReviewerIds.includes(reviewerId) && !review.approvals.some((approval) => approval.reviewerId === reviewerId && !review.revocations.some((revocation) => revocation.approvalId === approval.approvalId))) button(detail, "Approve exact candidate", async (button) => {
      if (!window.confirm(`Approve ${target.projectId}/${target.repositoryId} candidate ${review.candidateCommit} for ${review.protectedRef}?`)) { status.textContent = "Approval dismissed."; return false; }
      const value = /** @type {Review} */ (await invoke(target, "reviews.approve", { reviewId: review.reviewId })); showReview(value, target);
      return accepted(button, target, "Approval recorded.", [["review list", () => refreshList(target)]]);
    });
    if (has("reviews.promote") && review.status === "approved") button(detail, "Promote protected ref", async (button) => {
      if (!window.confirm(`Promote ${target.projectId}/${target.repositoryId} ${review.candidateCommit} to ${review.protectedRef}?`)) { status.textContent = "Promotion dismissed."; return false; }
      await invoke(target, "reviews.promote", { reviewId: review.reviewId }); return accepted(button, target, "Protected ref promotion accepted.", [["review list", () => refreshList(target)], ["review details", () => open(target, review.reviewId)]]);
    });
  }
  /** @param {Scope} target @param {string} reviewId */
  async function open(target, reviewId) { const version = ++detailVersion; const value = /** @type {Review} */ (await invoke(target, "reviews.detail", { reviewId })); if (selected(target) && detailVersion === version) showReview(value, target); }
  /** @param {Scope} [target] */
  async function refreshList(target = scope()) {
    const version = ++listVersion; if (!target.projectId || !target.repositoryId || !has("reviews.list")) return;
    const reviews = /** @type {Array<{reviewId:string,proposalRef:string,protectedRef:string,status:string,createdAt:string}>} */ (await invoke(target, "reviews.list"));
    if (!selected(target) || version !== listVersion) return;
    list.replaceChildren(element("h3", "Reviews"));
    if (!reviews.length) { list.append(element("p", "No reviews for this repository. Resolve a proposal ref below to start one.")); return; }
    const table = element("table"), header = element("tr"); for (const title of ["Proposal", "Protected ref", "State", "Created", "Evidence"]) header.append(element("th", title)); table.append(header);
    for (const review of reviews) { const row = element("tr"), actions = element("td"); row.append(element("td", review.proposalRef), element("td", review.protectedRef), element("td", review.status), element("td", new Date(review.createdAt).toLocaleString()), actions); button(actions, "Open review", () => open(target, review.reviewId)); table.append(row); } list.append(table);
  }
  function renderActions() {
    management.update();
    actions.replaceChildren(); form.hidden = !has("reviews.resolve") || !scope().repositoryId;
    if (!scope().repositoryId) return;
    button(actions, "Refresh reviews", (_button, target) => refreshList(target));
    for (const [operation, title] of [["sync.fetch", "Fetch upstream"], ["sync.merge", "Propose upstream merge"], ["sync.publish", "Publish protected head"]]) {
      if (!operation || !title || !has(operation)) continue;
      button(actions, title, async (button, target) => {
        if (operation === "sync.publish" && !window.confirm(`Publish ${target.projectId}/${target.repositoryId} protected head to its configured upstream branch?`)) { status.textContent = "Publish dismissed."; return false; }
        const result = /** @type {{outcome:string,proposalRef?:string,upstreamRef?:string,upstreamCommit?:string,sourceCommit?:string,targetRef?:string,candidateCommit?:string}} */ (await invoke(target, operation));
        if (!selected(target)) return false;
        syncStatus.replaceChildren(element("h3", `Upstream ${result.outcome}`));
        if (result.outcome === "conflict") syncStatus.append(element("p", "Upstream changes conflict with the protected branch. Resolve conflicts in a workspace and submit a proposal for review."));
        const details = element("dl"); for (const [label, value] of [["Upstream ref", result.upstreamRef], ["Upstream commit", result.upstreamCommit], ["Proposal ref", result.proposalRef], ["Candidate commit", result.candidateCommit], ["Published commit", result.sourceCommit], ["Published branch", result.targetRef]]) if (value) details.append(element("dt", label), element("dd", value)); syncStatus.append(details);
        return accepted(button, target, `${title}: ${result.outcome}.`, [["review list", () => refreshList(target)]], false);
      });
    }
  }
  function switchScope() {
    ++listVersion; ++detailVersion; ++formVersion; delete submit.dataset.pending; list.replaceChildren(); detail.replaceChildren(); syncStatus.replaceChildren(); status.textContent = ""; restoreDraft(); renderActions();
    const target = scope(); void refreshList(target).catch((error) => { if (selected(target)) status.textContent = `Could not load repository reviews: ${error instanceof Error ? error.message : "service unavailable"}.`; });
  }
  /** @param {HTMLSelectElement} control @param {Array<{id:string,title:string}>} values @param {string} preferred */
  function options(control, values, preferred) { control.replaceChildren(); for (const value of values) { const option = document.createElement("option"); option.value = value.id; option.textContent = value.title; control.append(option); } if (values.some(({ id }) => id === preferred)) control.value = preferred; control.disabled = values.length === 0; }
  function fillRepositories(preferred = "") { const selectedProject = controller()?.projects.find(({ projectId }) => projectId === project.control.value); options(repository.control, (selectedProject?.repositoryIds ?? []).map((id) => ({ id, title: id })), preferred); }
  function fillProjects(preferred = "", preferredRepository = "") { options(project.control, (controller()?.projects ?? []).map(({ projectId, name }) => ({ id: projectId, title: name === projectId ? name : `${name} (${projectId})` })), preferred); fillRepositories(preferredRepository); }
  /** @param {{controllerId:string,projectId:string,repositoryId?:string}} [preferred] */
  async function refreshCatalog(preferred) {
    const version = ++catalogVersion, before = scope(), previous = preferred ? { ...preferred, repositoryId: preferred.repositoryId ?? "" } : before; saveDraft();
    const value = /** @type {{controllers:Controller[]}} */ (await context.invoke("projects.list", {})); if (!current() || version !== catalogVersion) return;
    controllers = value.controllers; availability.replaceChildren();
    for (const entry of controllers.filter(({ status }) => status === "unavailable")) availability.append(element("p", `${entry.title}: project discovery is unavailable. Install the Native Git host plugin and select its control plane on this controller, then reconnect this feature. Other controllers remain usable; refresh projects to retry temporary outages.`));
    options(host.control, controllers.map(({ id, title }) => ({ id, title })), previous.controllerId); host.field.hidden = controllers.length < 2;
    if (!controllers.some(({ id, status }) => id === host.control.value && status === "ready")) { const ready = controllers.find(({ status }) => status === "ready"); if (ready) host.control.value = ready.id; }
    fillProjects(previous.projectId, previous.repositoryId);
    if (key(before) !== key(scope())) switchScope(); else { renderActions(); await refreshList(); }
    if (!controllers.some(({ projects }) => projects.length)) list.replaceChildren(element("p", "No registered projects or ready repositories discovered. Import a project on a controller, then refresh projects."));
  }
  host.control.addEventListener("change", () => { saveDraft(); fillProjects(); switchScope(); });
  project.control.addEventListener("change", () => { saveDraft(); fillRepositories(); switchScope(); });
  repository.control.addEventListener("change", () => { saveDraft(); switchScope(); });
  proposal.addEventListener("input", () => { saveDraft(); delete submit.dataset.accepted; if (submit.dataset.pending !== "true") submit.disabled = false; });
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); if (submit.disabled) return; const target = scope(), version = ++formVersion; submit.dataset.pending = "true"; submit.disabled = true;
    try { const value = /** @type {Review} */ (await invoke(target, "reviews.resolve", { proposalRef: proposal.value.trim() })); if (version !== formVersion) return; showReview(value, target); if (selected(target)) await accepted(submit, target, "Proposal review resolved.", [["review list", () => refreshList(target)]]); }
    catch (error) { if (version === formVersion && selected(target)) status.textContent = `Could not resolve proposal: ${error instanceof Error ? error.message : "service unavailable"}. Check the proposal ref and retry.`; }
    finally { if (version === formVersion) { delete submit.dataset.pending; if (current()) submit.disabled = selected(target) && submit.dataset.accepted === "true"; } }
  });
  button(toolbar, "Refresh projects", () => refreshCatalog());
  form.hidden = true;
  void refreshCatalog().catch((error) => { if (current()) status.textContent = `Could not discover projects: ${error instanceof Error ? error.message : "service unavailable"}. Use Refresh projects to retry.`; });
  return () => { management.dispose(); disposed = true; ++catalogVersion; ++detailVersion; ++listVersion; container.replaceChildren(); };
}
