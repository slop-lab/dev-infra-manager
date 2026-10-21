// @ts-check
/** @typedef {{operations:Array<{name:string,description:string,access:string}>,invoke(name:string,input?:unknown):Promise<unknown>,isCurrent():boolean}} Context */
/** @typedef {import('../dto.js').ReviewDto} Review */
/** @param {string} tag @param {string} [text] */
function element(tag, text = "") { const node = document.createElement(tag); node.textContent = text; return node; }
/** @param {HTMLElement} container @param {Context} context */
export function mount(container, context) {
  let disposed = false, listVersion = 0, detailVersion = 0, reviewerId = "";
  const current = () => !disposed && context.isCurrent();
  const allowed = new Set(context.operations.map((operation) => operation.name));
  const status = element("p"); status.setAttribute("role", "status");
  const select = document.createElement("select"); select.id = "git-repository-selector";
  const label = document.createElement("label"); label.htmlFor = select.id; label.textContent = "Repository";
  const list = element("section"), detail = element("section"), toolbar = element("div"); toolbar.className = "feature-actions";
  const selectorField = element("div"); selectorField.className = "field"; selectorField.append(label, select);
  container.append(element("p", "Review exact candidate evidence before approving and promoting protected changes."), selectorField, toolbar, status, list, detail);
  /** @param {HTMLElement} parent @param {string} title @param {(button:HTMLButtonElement)=>Promise<boolean|void>} action */
  function button(parent, title, action) {
    const node = document.createElement("button"); node.type = "button"; node.className = "button button-secondary"; node.textContent = title;
    node.addEventListener("click", async () => {
      node.disabled = true; status.textContent = `${title}…`;
      try { const result = await action(node); if (current() && result !== false) status.textContent = `${title} completed.`; }
      catch (error) { if (current()) status.textContent = `${title} failed: ${error instanceof Error ? error.message : "service unavailable"}. Refresh the review before trying again.`; }
      finally { if (current()) node.disabled = node.dataset.accepted === "true"; }
    }); parent.append(node); return node;
  }
  /** @param {HTMLButtonElement} button @param {string} receipt @param {Array<[string,()=>Promise<unknown>]>} reads @param {boolean} [lockUntilReload] */
  async function accepted(button, receipt, reads, lockUntilReload = true) {
    if (lockUntilReload) button.dataset.accepted = "true"; status.textContent = receipt;
    const results = await Promise.allSettled(reads.map(([, read]) => read()));
    if (current()) {
      const failed = reads.filter((_, index) => results[index]?.status === "rejected").map(([name]) => name);
      status.textContent = failed.length ? `${receipt} Latest ${failed.join(" and ")} could not refresh. Refresh this view to inspect current state; the action was accepted.` : receipt;
    }
    return false;
  }
  /** @param {Review} review */
  function showReview(review) {
    detail.replaceChildren(element("h3", `Review ${review.reviewId.slice(0, 12)} — ${review.status}`));
    const evidence = element("dl");
    for (const [key, value] of [["Proposal", review.proposalRef], ["Protected ref", review.protectedRef], ["Current protected commit", review.expectedProtectedHead], ["Candidate commit", review.candidateCommit], ["Candidate tree", review.candidateTree], ["Policy revision", review.policyRevision], ["Required reviewers", review.requiredReviewerIds.join(", ") || "None"], ["Stale reasons", review.staleReasons.join("; ") || "None"]]) evidence.append(element("dt", key), element("dd", value));
    detail.append(evidence, element("h4", "Changed files"));
    const changes = element("ul");
    for (const change of review.changes) changes.append(element("li", `${change.status}: ${change.oldPath ?? ""}${change.oldPath && change.newPath && change.oldPath !== change.newPath ? " → " : ""}${change.newPath && change.newPath !== change.oldPath ? change.newPath : ""}`));
    detail.append(changes);
    const diff = document.createElement("details"), summary = element("summary", `Patch (${review.patch.length.toLocaleString()} characters)`), patch = element("pre", review.patch || "No textual changes."); patch.className = "review-patch"; diff.append(summary, patch); detail.append(diff, element("h4", "Approvals"));
    const approvals = element("ul");
    for (const approval of review.approvals) {
      const revoked = review.revocations.some((revocation) => revocation.approvalId === approval.approvalId);
      const row = element("li", `${approval.reviewerId} — ${new Date(approval.approvedAt).toLocaleString()}${revoked ? " (revoked)" : ""}`);
      if (!revoked && approval.reviewerId === reviewerId && allowed.has("reviews.revoke")) button(row, `Revoke ${approval.reviewerId} approval`, async () => {
        if (!window.confirm(`Revoke approval ${approval.approvalId.slice(0, 12)} from ${approval.reviewerId}?`)) { status.textContent = "Revocation dismissed."; return false; }
        const value = /** @type {Review} */ (await context.invoke("reviews.revoke", { repositoryId: review.repositoryId, reviewId: review.reviewId, approvalId: approval.approvalId })); if (current() && select.value === review.repositoryId) showReview(value);
      }); approvals.append(row);
    }
    if (!review.approvals.length) approvals.append(element("li", "No approvals recorded.")); detail.append(approvals);
    if (allowed.has("reviews.approve") && review.status !== "stale" && review.requiredReviewerIds.includes(reviewerId) && !review.approvals.some((approval) => approval.reviewerId === reviewerId && !review.revocations.some((revocation) => revocation.approvalId === approval.approvalId))) button(detail, "Approve exact candidate", async (button) => {
      if (!window.confirm(`Approve candidate ${review.candidateCommit} for ${review.protectedRef}?`)) { status.textContent = "Approval dismissed."; return false; }
      const value = /** @type {Review} */ (await context.invoke("reviews.approve", { repositoryId: review.repositoryId, reviewId: review.reviewId })); if (current() && select.value === review.repositoryId) showReview(value); return accepted(button, "Approval recorded.", [["review list", refreshList]]);
    });
    if (allowed.has("reviews.promote") && review.status === "approved") button(detail, "Promote protected ref", async (button) => {
      if (!window.confirm(`Promote ${review.candidateCommit} to ${review.protectedRef}?`)) { status.textContent = "Promotion dismissed."; return false; }
      await context.invoke("reviews.promote", { repositoryId: review.repositoryId, reviewId: review.reviewId }); return accepted(button, "Protected ref promotion accepted.", [["review list", refreshList], ["review details", () => open(review.repositoryId, review.reviewId)]]);
    });
  }
  /** @param {string} repositoryId @param {string} reviewId */
  async function open(repositoryId, reviewId) {
    const version = ++detailVersion;
    const value = /** @type {Review} */ (await context.invoke("reviews.detail", { repositoryId, reviewId }));
    if (current() && select.value === repositoryId && detailVersion === version) showReview(value);
  }
  async function refreshList() {
    const repositoryId = select.value, version = ++listVersion;
    if (!repositoryId) return;
    const reviews = /** @type {Array<{reviewId:string,proposalRef:string,protectedRef:string,status:string,createdAt:string}>} */ (await context.invoke("reviews.list", { repositoryId }));
    if (!current() || select.value !== repositoryId || version !== listVersion) return;
    list.replaceChildren(element("h3", "Reviews"));
    if (!reviews.length) { list.append(element("p", "No reviews for this repository. Resolve a proposal ref below to start one.")); return; }
    const table = element("table"), header = element("tr");
    for (const title of ["Proposal", "Protected ref", "State", "Created", "Evidence"]) header.append(element("th", title)); table.append(header);
    for (const review of reviews) { const row = element("tr"), actions = element("td"); row.append(element("td", review.proposalRef), element("td", review.protectedRef), element("td", review.status), element("td", new Date(review.createdAt).toLocaleString()), actions); button(actions, "Open review", () => open(repositoryId, review.reviewId)); table.append(row); }
    list.append(table);
  }
  button(toolbar, "Refresh reviews", refreshList);
  if (allowed.has("reviews.resolve")) {
    const form = document.createElement("form"), proposal = document.createElement("input"), proposalLabel = document.createElement("label"), submit = document.createElement("button");
    proposal.id = "git-proposal-ref"; proposal.required = true; proposal.maxLength = 1024; proposal.placeholder = "refs/dim/proposals/…"; proposalLabel.htmlFor = proposal.id; proposalLabel.textContent = "Proposal ref"; submit.type = "submit"; submit.className = "button"; submit.textContent = "Resolve proposal review"; const field = element("div"); field.className = "field"; field.append(proposalLabel, proposal); form.append(field, submit); container.insertBefore(form, list);
    proposal.addEventListener("input", () => { delete submit.dataset.accepted; if (submit.dataset.pending !== "true") submit.disabled = false; });
    select.addEventListener("change", () => { delete submit.dataset.accepted; if (submit.dataset.pending !== "true") submit.disabled = false; });
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); if (submit.disabled) return; submit.dataset.pending = "true"; submit.disabled = true; const repositoryId = select.value;
      try { const review = /** @type {Review} */ (await context.invoke("reviews.resolve", { repositoryId, proposalRef: proposal.value.trim() })); if (current() && select.value === repositoryId) { showReview(review); status.textContent = "Proposal review resolved."; } await accepted(submit, "Proposal review resolved.", [["review list", refreshList]]); }
      catch (error) { if (current()) status.textContent = `Could not resolve proposal: ${error instanceof Error ? error.message : "service unavailable"}. Check the proposal ref and retry.`; }
      finally { delete submit.dataset.pending; if (current()) submit.disabled = submit.dataset.accepted === "true"; }
    });
  }
  const syncStatus = element("section"); container.insertBefore(syncStatus, list);
  for (const [operation, title] of [["sync.fetch", "Fetch upstream"], ["sync.merge", "Propose upstream merge"], ["sync.publish", "Publish protected head"]]) {
    if (!operation || !title || !allowed.has(operation)) continue;
    button(toolbar, title, async (button) => {
      const repositoryId = select.value;
      if (operation === "sync.publish" && !window.confirm(`Publish the protected head of ${repositoryId} to its configured upstream branch?`)) { status.textContent = "Publish dismissed."; return false; }
      const result = /** @type {{outcome:string,proposalRef?:string,upstreamRef?:string,upstreamCommit?:string,sourceCommit?:string,targetRef?:string,candidateCommit?:string}} */ (await context.invoke(operation, { repositoryId }));
      if (!current() || select.value !== repositoryId) return;
      syncStatus.replaceChildren(element("h3", `Upstream ${result.outcome}`));
      if (result.outcome === "conflict") syncStatus.append(element("p", "Upstream changes conflict with the protected branch. Resolve conflicts in a workspace and submit a proposal for review."));
      const details = element("dl");
      for (const [key, value] of [["Upstream ref", result.upstreamRef], ["Upstream commit", result.upstreamCommit], ["Proposal ref", result.proposalRef], ["Candidate commit", result.candidateCommit], ["Published commit", result.sourceCommit], ["Published branch", result.targetRef]]) if (value) details.append(element("dt", key), element("dd", value));
      syncStatus.append(details); return accepted(button, `${title}: ${result.outcome}.`, [["review list", refreshList]], false);
    });
  }
  select.addEventListener("change", () => { ++detailVersion; detail.replaceChildren(); syncStatus.replaceChildren(); void refreshList().catch((error) => { if (current()) status.textContent = `Could not load repository reviews: ${error instanceof Error ? error.message : "service unavailable"}.`; }); });
  void (async () => {
    const scope = /** @type {{projectId:string,repositoryIds:string[],reviewerId:string}} */ (await context.invoke("repositories.list", {}));
    if (!current()) return;
    reviewerId = scope.reviewerId;
    for (const id of scope.repositoryIds) { const option = document.createElement("option"); option.value = id; option.textContent = `${scope.projectId}/${id}`; select.append(option); } await refreshList();
  })().catch((error) => { if (current()) status.textContent = `Could not load repositories: ${error instanceof Error ? error.message : "service unavailable"}. Reopen this page to retry.`; });
  return () => { disposed = true; ++detailVersion; ++listVersion; container.replaceChildren(); };
}
