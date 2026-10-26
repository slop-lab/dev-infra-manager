// @ts-check
import { mountManagement } from "./management.js";
import { appendNativeGitNavigationActions, registerNativeGitNavigation } from "./navigation.js";
import { appendReviewCi, reviewApprovalAvailability } from "./review-detail.js";
/** @typedef {{name:string,description:string,access:string}} Descriptor */
/** @typedef {import('@slop-lab/dim-web/plugin-api').WebPluginBrowserContext} Context */
/** @typedef {import('@slop-lab/dim-service-client-native-git').ReviewDto} Review */
/** @typedef {{controllerId:string,projectId:string,repositoryId:string}} Scope */
/** @typedef {{id:string,controllerKey?:string,title:string,status:'ready'|'unavailable',reviewerId?:string,projects:Array<{projectId:string,name:string,repositoryIds:string[],repositories?:Array<{repositoryId:string,defaultRef:string,branches:string[]}>}>,operations:Descriptor[]}} Controller */
/** @param {HTMLElement} container @param {Context} context */
export function mount(container, context) {
  let disposed = false, catalogVersion = 0, listVersion = 0, detailVersion = 0, formVersion = 0, scopeRevision = 0;
  /** @type {Controller[]} */ let controllers = [];
  /** @type {Map<string,string>} */ const drafts = new Map();
  const { ui } = context, element = ui.element;
  const current = () => !disposed && context.isCurrent();
  const status = element("p"); status.setAttribute("role", "status");
  const managementRegion = element("div"), pullRequestRegion = element("section");
  const availability = element("div"), selectors = element("div"), guidance = element("section", "", "panel"), toolbar = element("div"), actions = element("div"), navigationActions = element("div"), list = element("section"), detail = element("section"), syncStatus = element("section", "", "sync-result");
  toolbar.className = actions.className = navigationActions.className = "feature-actions";
  /** @param {string} label */
  function selector(label) { const control = ui.select(selectors, label, []); const field = control.parentElement; if (!(field instanceof HTMLLabelElement)) throw new Error("Missing selector field"); return { field, control }; }
  const host = selector("Git connection"), project = selector("Project"), repository = selector("Repository");
  const metadata = () => controller()?.projects.find(({ projectId }) => projectId === project.control.value)?.repositories?.find(({ repositoryId }) => repositoryId === repository.control.value);
  const advanced = document.createElement("details"), advancedSelectors = element("div"); advanced.append(element("summary", "Advanced: exact reviews and upstream sync"), advancedSelectors);
  const targetBranch = ui.select(advancedSelectors, "Review target branch", []);
  /** @type {Map<string,{source:string,target:string}>} */ const branchDrafts = new Map();
  const form = document.createElement("form"), proposal = ui.input(form, "Proposal ref"), submit = ui.button("Resolve proposal review", "primary");
  proposal.required = true; proposal.maxLength = 1024; proposal.placeholder = "refs/heads/feature or refs/tags/release-candidate"; submit.type = "submit"; form.append(submit);
  const filters = element("div", "", "workspace-filters"), reviewSearch = ui.input(filters, "Search reviews"), reviewState = ui.select(filters, "Review state", [
    { value: "", label: "All states" }, { value: "pending", label: "Pending" }, { value: "approved", label: "Approved" }, { value: "revoked", label: "Revoked" }, { value: "stale", label: "Stale" }
  ]);
  reviewSearch.placeholder = "Proposal, protected ref or review ID";
  advanced.append(actions, form, syncStatus, filters, list, detail);
  container.append(element("p", "Choose a project and repository, then create a pull request to review and merge a pushed branch."), toolbar, availability, selectors, guidance, navigationActions, managementRegion, status, pullRequestRegion, advanced);
  /** @type {Array<{reviewId:string,proposalRef:string,protectedRef:string,status:string,createdAt:string}>} */ let loadedReviews = [];
  /** @returns {Scope} */ const scope = () => ({ controllerId: host.control.value, projectId: project.control.value, repositoryId: repository.control.value });
  /** @param {Scope} value */ const key = (value) => JSON.stringify([value.controllerId, value.projectId, value.repositoryId]);
  /** @param {Scope} value */ const selected = (value) => current() && key(value) === key(scope());
  const controller = () => controllers.find(({ id }) => id === host.control.value);
  /** @param {string} name */ const has = (name) => context.operations.some((operation) => operation.name === name) && Boolean(controller()?.operations.some((operation) => operation.name === name));
  /** @param {Scope} target @param {string} name @param {Record<string,unknown>} [input] */
  const invoke = (target, name, input = {}) => context.invoke(name, { ...target, ...input }, /^(?:reviews|merges|sync)\./.test(name) ? { timeoutMilliseconds: 125_000 } : undefined);
  const management = mountManagement(managementRegion, context, { scope, has, hostAuthority: () => Boolean(controller()?.controllerKey), refresh: (preferred) => refreshCatalog(preferred) });
  /** @type {ReturnType<import('../pull-requests.js').mountPullRequests>|undefined} */ let pullRequests;
  const prAsset = new URL("./pull-requests.js", import.meta.url).href;
  void import(prAsset).then((module) => {
    if (!current()) return;
    const adapter = /** @type {typeof import('../pull-requests.js')} */ (module);
    pullRequests = adapter.mountPullRequests(pullRequestRegion, context, { scope, has, current: selected, reviewerId: () => controller()?.reviewerId, targetRefs: () => metadata()?.branches ?? [], defaultTargetRef: () => metadata()?.defaultRef });
    void pullRequests.refresh();
  }).catch(() => { if (current()) pullRequestRegion.textContent = "Pull request UI could not load. Reopen Git review to retry."; });
  let draftKey = "";
  function saveDraft() { if (draftKey) drafts.set(draftKey, proposal.value); }
  function restoreDraft() { draftKey = key(scope()); proposal.value = drafts.get(draftKey) ?? ""; delete submit.dataset.accepted; submit.disabled = false; }
  /** @param {HTMLElement} parent @param {string} title @param {(button:HTMLButtonElement,target:Scope)=>Promise<boolean|void>} action */
  function button(parent, title, action) {
    const node = ui.button(title);
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
    advanced.open = true;
    const reviewerId = controller()?.reviewerId;
    detail.replaceChildren(element("p", "Selected review evidence is retained independently of list filters.", "field-hint"), element("h3", `Review ${review.reviewId.slice(0, 12)} — ${review.status}`));
     const evidence = [["Project / repository", `${review.projectId}/${review.repositoryId}`], ["Proposal", review.proposalRef], ["Protected ref", review.protectedRef], ["Current protected commit", review.expectedProtectedHead], ["Candidate commit", review.candidateCommit], ["Candidate tree", review.candidateTree], ["Policy revision", review.policyRevision], ["Required reviewers", review.requiredReviewerIds.join(", ") || "None"], ["Stale reasons", review.staleReasons.join("; ") || "None"]];
      detail.append(ui.table(["Evidence", "Exact value"], evidence));
     appendReviewCi({ detail, review, ui, element });
     detail.append(element("h4", "Changed files"));
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
    const approvalAccess = reviewApprovalAvailability(review, { reviewerId, browserCanApprove: context.operations.some(({ name }) => name === "reviews.approve"), controllerCanApprove: Boolean(controller()?.operations.some(({ name }) => name === "reviews.approve")) });
    const explanation = element("p", approvalAccess.message, "field-hint"); explanation.id = `review-approval-${review.reviewId}`; detail.append(explanation);
    if (approvalAccess.state === "role-required") {
      const configure = ui.button("Configure review access"); configure.addEventListener("click", () => window.dispatchEvent(new Event("dim-account-access"))); detail.append(configure);
    }
    detail.append(element("p", `Decision target: ${review.projectId}/${review.repositoryId} · ${review.protectedRef} · candidate ${review.candidateCommit}`, "workspace-feedback"));
    if (approvalAccess.state !== "available") { const blocked = ui.button("Approve exact candidate"); blocked.disabled = true; blocked.setAttribute("aria-describedby", explanation.id); detail.append(blocked); }
    else button(detail, "Approve exact candidate", async (button) => {
      if (!window.confirm(`Approve ${target.projectId}/${target.repositoryId} candidate ${review.candidateCommit} for ${review.protectedRef}?`)) { status.textContent = "Approval dismissed."; return false; }
      const value = /** @type {Review} */ (await invoke(target, "reviews.approve", { reviewId: review.reviewId })); showReview(value, target);
      return accepted(button, target, "Approval recorded.", [["review list", () => refreshList(target)]]);
    });
    if (has("reviews.promote") && review.status === "approved") button(detail, "Promote protected ref", async (button) => {
      if (!window.confirm(`Promote ${target.projectId}/${target.repositoryId} ${review.candidateCommit} to ${review.protectedRef}?`)) { status.textContent = "Promotion dismissed."; return false; }
      await invoke(target, "reviews.promote", { reviewId: review.reviewId }); return accepted(button, target, "Protected ref promotion accepted.", [["review list", () => refreshList(target)], ["review details", () => open(target, review.reviewId)]]);
    });
  }
  /** @param {Scope} target @param {string} reviewId @param {()=>boolean} [isCurrent] */
  async function open(target, reviewId, isCurrent = current) { const version = ++detailVersion; const value = /** @type {Review} */ (await invoke(target, "reviews.detail", { reviewId })); if (isCurrent() && selected(target) && detailVersion === version) showReview(value, target); }
  function paintReviews() {
    const query = reviewSearch.value.trim().toLowerCase(), state = reviewState.value;
    const reviews = loadedReviews.filter((review) => (!state || review.status === state) && review.protectedRef === targetBranch.value && (!query || [review.reviewId, review.proposalRef, review.protectedRef].some((value) => value.toLowerCase().includes(query))));
    list.replaceChildren(element("h3", "Reviews"));
    if (!loadedReviews.length) { list.append(element("p", "No reviews for this repository. Resolve a proposal ref below to start one.")); return; }
    if (!reviews.length) { list.append(element("p", "No reviews match the current search and state filter.")); return; }
    const target = scope(), table = ui.table(["Proposal", "Protected ref", "State", "Created", "Evidence"], reviews.map((review) => [review.proposalRef, review.protectedRef, review.status, new Date(review.createdAt).toLocaleString(), ""]));
    const rows = table.querySelectorAll("tbody tr");
    reviews.forEach((review, index) => { const cell = rows[index]?.lastElementChild; if (cell instanceof HTMLElement) button(cell, "Open review", () => open(target, review.reviewId)); });
    list.append(table);
  }
  /** @param {Scope} [target] */
  async function refreshList(target = scope()) {
    const version = ++listVersion; if (!target.projectId || !target.repositoryId || !has("reviews.list")) return;
    const reviews = /** @type {Array<{reviewId:string,proposalRef:string,protectedRef:string,status:string,createdAt:string}>} */ (await invoke(target, "reviews.list"));
    if (!selected(target) || version !== listVersion) return;
    loadedReviews = reviews; paintReviews();
  }
  function renderGuidance() {
    const target = scope();
    guidance.replaceChildren(element("h3", "Merge a branch"));
    if (!target.repositoryId) { guidance.append(element("p", "Select a repository to see its exact target and available next actions.")); return; }
    guidance.append(element("p", `Git connection: ${controller()?.title ?? target.controllerId} · ${target.projectId}/${target.repositoryId}.`, "workspace-feedback"));
    guidance.append(element("p", has("pull-requests.create")
      ? "Create a pull request from your pushed source branch to a repository target branch. Inspect its changes, prepare review to check DIM CI and required approvals, then merge when those checks allow it."
      : has("pull-requests.list") ? "Select a pull request to inspect its changes and checks. Creating or merging requires the corresponding access on this Git connection."
        : "Open Advanced to inspect exact reviews or prepare a branch merge with the operations available to this connection.", "field-hint"));
    const access = document.createElement("details"); access.append(element("summary", "Connection scope and access"));
    const capabilities = element("ul");
    capabilities.append(element("li", has("reviews.resolve")
      ? `Reviewer: available${controller()?.reviewerId ? ` as ${controller()?.reviewerId}` : ""}. Resolution and decisions stay bound to exact evidence.`
      : "Review-only: evidence can be inspected. To resolve or approve reviews, ask an operator for the reviewer role on your Web account and sign in again. A matching Git reviewer connection must also be available."));
    capabilities.append(element("li", has("sync.merge")
      ? "Sync operator: available. Merge creates a proposal and never advances the protected ref."
      : "Sync operator: unavailable. Operator browser access and a matching sync connection are required."));
    capabilities.append(element("li", has("reviews.promote")
      ? "Promoter: available when this review's requirements are satisfied; current policy and heads are rechecked."
      : "Promoter: unavailable. Operator browser access and a matching promoter connection are required."));
    access.append(capabilities, element("p", "Access applies to this Web session and Git connection only. Every action rechecks the selected repository and your authority.", "field-hint")); guidance.append(access);
  }
  function renderActions() {
    management.update();
    renderGuidance();
    const primary = has("pull-requests.list"); if (advanced.dataset.primary !== String(primary)) { advanced.open = !primary; advanced.dataset.primary = String(primary); }
    actions.replaceChildren(); navigationActions.replaceChildren(); form.hidden = !has("reviews.resolve") || !scope().repositoryId;
    if (!scope().repositoryId) return;
    if (has("merges.prepare")) {
      const mergeForm = document.createElement("form"), source = ui.input(mergeForm, "Merge source branch");
      const refs = metadata()?.branches ?? [], destination = refs.length ? ui.select(mergeForm, "Merge target branch", refs.map(value => ({ value, label: value.replace(/^refs\/heads\//, "") }))) : ui.input(mergeForm, "Merge target branch");
      const mergeScope = key(scope()), saved = branchDrafts.get(mergeScope);
      source.value = saved?.source ?? ""; source.placeholder = "development-tmp or feature/my-change"; destination.value = saved?.target ?? metadata()?.defaultRef ?? ""; source.required = destination.required = true;
      const prepare = ui.button("Create branch merge review", "primary"); prepare.type = "submit"; mergeForm.append(prepare); actions.append(mergeForm);
      mergeForm.addEventListener("submit", async (event) => {
        event.preventDefault(); if (prepare.disabled) return; const target = scope(); prepare.disabled = source.disabled = destination.disabled = true;
        const ref = (/** @type {string} */ value) => value.startsWith("refs/heads/") ? value : `refs/heads/${value}`;
        try {
          const result = /** @type {{outcome:string,reviewId?:string}} */ (await invoke(target, "merges.prepare", { sourceRef: ref(source.value.trim()), targetRef: ref(destination.value.trim()) }));
          if (result.outcome === "proposed") prepare.dataset.accepted = "true";
          if (!selected(target)) return;
          const receipt = result.outcome === "proposed" ? "Branch merge review created. Inspect its changes and required approvals, then promote it." : result.outcome === "conflict" ? "Branches conflict. Resolve the changes in a workspace and submit a proposal." : "The target already contains the source branch.";
          /** @type {Array<[string,()=>Promise<unknown>]>} */ const reads = [["review list", () => refreshList(target)]];
          if (result.reviewId) { const reviewId = result.reviewId; reads.push(["review details", () => open(target, reviewId)]); }
          await accepted(prepare, target, receipt, reads, result.outcome === "proposed");
        } catch (error) { if (selected(target)) status.textContent = `Could not create branch merge review: ${error instanceof Error ? error.message : "service unavailable"}.`; }
        finally { if (current()) { prepare.disabled = prepare.dataset.accepted === "true"; source.disabled = destination.disabled = false; } }
      });
      for (const input of [source, destination]) input.addEventListener("input", () => { branchDrafts.set(mergeScope, { source: source.value, target: destination.value }); delete prepare.dataset.accepted; prepare.disabled = false; });
    }
    button(actions, "Refresh reviews", (_button, target) => refreshList(target));
    for (const [operation, title] of [["sync.fetch", "Fetch upstream"], ["sync.merge", "Propose upstream merge"], ["sync.publish", "Publish protected head"]]) {
      if (!operation || !title || !has(operation)) continue;
      button(actions, title, async (actionButton, target) => {
        const protectedRef = targetBranch.value;
        if (operation === "sync.publish" && !window.confirm(`Publish ${target.projectId}/${target.repositoryId} ${protectedRef} to its configured upstream branch?`)) { status.textContent = "Publish dismissed."; return false; }
        const result = /** @type {{outcome:string,proposalRef?:string,upstreamRef?:string,upstreamCommit?:string,sourceCommit?:string,targetRef?:string,candidateCommit?:string}} */ (await invoke(target, operation, { protectedRef }));
        if (!selected(target)) return false;
        syncStatus.replaceChildren(element("h3", `Upstream ${result.outcome}`));
        if (result.outcome === "conflict") syncStatus.append(element("p", "Upstream changes conflict with the protected branch. Resolve conflicts in a workspace and submit a proposal for review."));
        const details = element("dl"); for (const [label, value] of [["Upstream ref", result.upstreamRef], ["Upstream commit", result.upstreamCommit], ["Proposal ref", result.proposalRef], ["Candidate commit", result.candidateCommit], ["Published commit", result.sourceCommit], ["Published branch", result.targetRef]]) if (value) details.append(element("dt", label), element("dd", value)); syncStatus.append(details);
        if (operation === "sync.merge" && result.proposalRef) {
          if (has("reviews.resolve")) button(syncStatus, "Review upstream proposal", async (reviewButton, reviewTarget) => {
            const review = /** @type {Review} */ (await invoke(reviewTarget, "reviews.resolve", { proposalRef: result.proposalRef, protectedRef }));
            showReview(review, reviewTarget);
            return accepted(reviewButton, reviewTarget, "Proposal review resolved.", [["review list", () => refreshList(reviewTarget)]]);
          });
          else syncStatus.append(element("p", "This proposal is ready for exact review, but proposal resolution is not available to this session and connection.", "field-hint"));
        }
        return accepted(actionButton, target, `${title}: ${result.outcome}.`, [["review list", () => refreshList(target)]], false);
      });
    }
    const target = scope(), controllerKey = controller()?.controllerKey;
    const selectedProject = controller()?.projects.find(({ projectId }) => projectId === target.projectId), projectRepositories = selectedProject?.repositoryIds;
    appendNativeGitNavigationActions(navigationActions, status, context, { ...(controllerKey ? { controllerKey } : {}), projectId: target.projectId, ...(selectedProject ? { projectName: selectedProject.name } : {}), repositoryId: target.repositoryId, ...(projectRepositories ? { repositoryIds: projectRepositories } : {}) }, () => selected(target));
  }
  function switchScope() {
    const branchPolicy = metadata(), refs = branchPolicy?.branches ?? ["refs/heads/main"];
    options(targetBranch, refs.map((id) => ({ id, title: id.slice("refs/heads/".length) })), branchPolicy?.defaultRef ?? "refs/heads/main");
    void pullRequests?.refresh();
    ++scopeRevision; ++listVersion; ++detailVersion; ++formVersion; loadedReviews = []; delete submit.dataset.pending; list.replaceChildren(); detail.replaceChildren(); syncStatus.replaceChildren(); status.textContent = ""; restoreDraft(); renderActions();
    const target = scope(); void refreshList(target).catch((error) => { if (selected(target)) status.textContent = `Could not load repository reviews: ${error instanceof Error ? error.message : "service unavailable"}.`; });
  }
  /** @param {HTMLSelectElement} control @param {Array<{id:string,title:string}>} values @param {string} preferred */
  function options(control, values, preferred) { control.replaceChildren(); for (const value of values) { const option = document.createElement("option"); option.value = value.id; option.textContent = value.title; control.append(option); } if (values.some(({ id }) => id === preferred)) control.value = preferred; control.disabled = values.length === 0; }
  function fillRepositories(preferred = "") { const selectedProject = controller()?.projects.find(({ projectId }) => projectId === project.control.value); options(repository.control, (selectedProject?.repositoryIds ?? []).map((id) => ({ id, title: id })), preferred); }
  function fillProjects(preferred = "", preferredRepository = "") { options(project.control, (controller()?.projects ?? []).map(({ projectId, name }) => ({ id: projectId, title: name === projectId ? name : `${name} (${projectId})` })), preferred); fillRepositories(preferredRepository); }
  /** @param {{controllerId:string,projectId:string,repositoryId?:string}} [preferred] */
  async function refreshCatalog(preferred) {
    const version = ++catalogVersion, before = scope(), previous = preferred ? { ...preferred, repositoryId: preferred.repositoryId ?? "" } : before; saveDraft();
    const value = /** @type {{controllers:Controller[]}} */ (await context.invoke("projects.list", {}, { timeoutMilliseconds: 125_000 })); if (!current() || version !== catalogVersion) return;
    controllers = value.controllers; availability.replaceChildren();
    for (const entry of controllers.filter(({ status }) => status === "unavailable")) availability.append(element("p", `${entry.title}: project discovery is unavailable. Ask the operator to repair this Git connection, then refresh projects. Other Git connections remain usable.`));
    options(host.control, controllers.map(({ id, title, status }) => ({ id, title: status === "unavailable" ? `${title} (unavailable)` : title })), previous.controllerId); host.field.hidden = controllers.length === 1 && controllers[0]?.status === "ready";
    if (!controllers.some(({ id, status }) => id === host.control.value && status === "ready")) { const ready = controllers.find(({ status }) => status === "ready"); if (ready) host.control.value = ready.id; }
    fillProjects(previous.projectId, previous.repositoryId);
    if (key(before) !== key(scope())) switchScope(); else { renderActions(); await refreshList(); }
    if (!controllers.some(({ projects }) => projects.length)) list.replaceChildren(element("p", "No registered projects or ready repositories discovered. Import a project through an available Git connection, then refresh projects."));
  }
  host.control.addEventListener("change", () => { saveDraft(); fillProjects(); switchScope(); });
  project.control.addEventListener("change", () => { saveDraft(); fillRepositories(); switchScope(); });
  targetBranch.addEventListener("change", () => { paintReviews(); detail.replaceChildren(); renderGuidance(); });
  repository.control.addEventListener("change", () => { saveDraft(); switchScope(); });
  proposal.addEventListener("input", () => { saveDraft(); delete submit.dataset.accepted; if (submit.dataset.pending !== "true") submit.disabled = false; });
  reviewSearch.addEventListener("input", paintReviews); reviewState.addEventListener("change", paintReviews);
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); if (submit.disabled) return; const target = scope(), version = ++formVersion; submit.dataset.pending = "true"; submit.disabled = true;
    try { const value = /** @type {Review} */ (await invoke(target, "reviews.resolve", { proposalRef: proposal.value.trim(), protectedRef: targetBranch.value.startsWith("refs/heads/") ? targetBranch.value : `refs/heads/${targetBranch.value}` })); if (version !== formVersion) return; showReview(value, target); if (selected(target)) await accepted(submit, target, "Proposal review resolved.", [["review list", () => refreshList(target)]]); }
    catch (error) { if (version === formVersion && selected(target)) status.textContent = `Could not resolve proposal: ${error instanceof Error ? error.message : "service unavailable"}. Check the proposal ref and retry.`; }
    finally { if (version === formVersion) { delete submit.dataset.pending; if (current()) submit.disabled = selected(target) && submit.dataset.accepted === "true"; } }
  });
  button(toolbar, "Refresh projects", () => refreshCatalog());
  form.hidden = true;
  const initialDiscovery = refreshCatalog();
  const disposeNavigation = registerNativeGitNavigation(context, {
    ready: initialDiscovery,
    controllers: () => controllers,
    async open(target, isCurrent) {
      const revision = scopeRevision, catalog = catalogVersion, selection = key(scope());
      const reviewId = target.kind === "review" ? target.reviewId : undefined;
      const entry = controllers.find(({ controllerKey }) => controllerKey === target.controllerKey);
      if (!entry) return false;
      const requested = { controllerId: entry.id, projectId: target.projectId, repositoryId: target.repositoryId };
      /** @type {Review|undefined} */ let reviewed;
      if (reviewId) {
        // The exact read authenticates and scopes the review itself. Listing the
        // entire history first duplicates initial discovery and excludes valid
        // deep links once their review ages out of the bounded summary list.
        try { reviewed = /** @type {Review} */ (await invoke(requested, "reviews.detail", { reviewId })); }
        catch { return false; }
        if (reviewed.projectId !== requested.projectId || reviewed.repositoryId !== requested.repositoryId) return false;
      }
      if (!current() || !isCurrent() || revision !== scopeRevision || catalog !== catalogVersion || selection !== key(scope())) return false;
      saveDraft(); host.control.value = entry.id; fillProjects(target.projectId, target.repositoryId);
      if (project.control.value !== target.projectId || repository.control.value !== target.repositoryId) return false;
      if (selection !== key(requested)) switchScope();
      if (reviewed) showReview(reviewed, requested);
      return true;
    }
  });
  void initialDiscovery.catch((error) => { if (current()) status.textContent = `Could not discover projects: ${error instanceof Error ? error.message : "service unavailable"}. Use Refresh projects to retry.`; });
  return () => { pullRequests?.dispose(); disposeNavigation(); management.dispose(); disposed = true; ++catalogVersion; ++detailVersion; ++listVersion; container.replaceChildren(); };
}
