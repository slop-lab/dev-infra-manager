import { createElement as h } from "react";
import { mountPullRequestPanel, type PullRequestPanelProps } from "@slop-lab/react-git-pull-requests";
import type { GitLineAttribution } from "@slop-lab/git-blame";
import { currentRevision, parsePullRequest, parsePullRequestList, type PullRequest } from "@slop-lab/git-pull-requests";
import { parseDiffSnapshot, type DiffSnapshot } from "@slop-lab/git-diff";
import type { ReviewDto } from "@slop-lab/dim-service-client-native-git";
import type { WebPluginBrowserContext } from "@slop-lab/dim-web/plugin-api";
import { reviewCiSummary } from "./review-ci.js";
export interface PullRequestScope { readonly controllerId: string; readonly projectId: string; readonly repositoryId: string }
export interface PullRequestHost {
  scope(): PullRequestScope;
  has(name: string): boolean;
  current(scope: PullRequestScope): boolean;
  reviewerId(): string | undefined;
}
export function pullRequestMergeDisabled(pr: PullRequest, review: ReviewDto | null): boolean {
  if (pr.state !== "open") return true;
  if (!review) return false;
  const ciReady = review.ci?.state === "not-configured" || review.ci?.state === "not-required" || review.ci?.state === "succeeded";
  return review.status !== "approved" || !ciReady;
}
/** DIM adapter only: portable React packages receive controlled data/callbacks. */
export function mountPullRequests(container: HTMLElement, context: WebPluginBrowserContext, host: PullRequestHost) {
  const styles = ["git-diff.css", "pull-requests.css"].map(file => {
    const link = document.createElement("link"); link.rel = "stylesheet";
    link.href = new URL(file, import.meta.url).href; document.head.append(link); return link;
  });
  let disposed = false, generation = 0, scopeKey = "";
  let rows: readonly PullRequest[] = [], selected: PullRequest | null = null, snapshot: DiffSnapshot | null = null;
  let review: ReviewDto | null = null, feedback = "", mergeRefreshPending = false;
  const root = mountPullRequestPanel(container, { pullRequests: [], selected: null, snapshot: null });
  const active = (scope: PullRequestScope, expected: number) => !disposed && context.isCurrent() && host.current(scope) && generation === expected;
  async function invoke(scope: PullRequestScope, name: string, input: Record<string, unknown> = {}) {
    if (disposed || !context.isCurrent() || !host.current(scope)) throw new Error("Repository selection changed");
    return context.invoke(name, { ...scope, ...input }, { timeoutMilliseconds: 125_000 });
  }
  function current() { if (!selected) throw new Error("Select a pull request first"); return selected; }
  function mutationInput(pr = current()) { return { pullRequestId: pr.id, expectedVersion: pr.version }; }
  async function inspect(scope: PullRequestScope, pr: PullRequest, expected: number) {
    const pinned = currentRevision(pr);
    const results = await Promise.allSettled([
      host.has("diff.read") ? invoke(scope, "diff.read", { baseCommit: pinned.targetCommit, headCommit: pinned.sourceCommit }).then(parseDiffSnapshot) : Promise.resolve(null),
      invoke(scope, "reviews.list").then(async raw => {
        const entries = raw as Array<{ reviewId: string; proposalRef: string; protectedRef: string; candidateCommit: string }>;
        const found = entries.find(entry => entry.proposalRef === pr.sourceRef && entry.protectedRef === pr.targetRef && entry.candidateCommit === pinned.sourceCommit);
        return found ? await invoke(scope, "reviews.detail", { reviewId: found.reviewId }) as ReviewDto : null;
      })
    ]);
    if (!active(scope, expected) || selected?.id !== pr.id || currentRevision(selected).id !== pinned.id) return;
    snapshot = results[0].status === "fulfilled" ? results[0].value : null;
    review = results[1].status === "fulfilled" ? results[1].value : null;
    feedback = results.some(result => result.status === "rejected") ? "Some revision details could not load. Refresh before taking a decision." : "";
    render();
  }
  async function accept(scope: PullRequestScope, value: unknown, expected: number) {
    const pr = parsePullRequest(value);
    if (!active(scope, expected)) return;
    rows = [pr, ...rows.filter(row => row.id !== pr.id)]; selected = pr; snapshot = null; review = null; feedback = ""; mergeRefreshPending = false; render();
    await inspect(scope, pr, expected);
  }
  async function select(id: string) {
    const scope = host.scope(), expected = ++generation;
    await accept(scope, await invoke(scope, "pull-requests.detail", { pullRequestId: id }), expected);
  }
  async function prepareReview() {
    const scope = host.scope(), expected = generation, pr = current(), pinned = currentRevision(pr);
    const value = await invoke(scope, "pull-requests.review", mutationInput(pr)) as { revisionId: string; review: { review: { reviewId: string } } };
    if (!active(scope, expected) || selected?.id !== pr.id || value.revisionId !== pinned.id) throw new Error("The selected revision changed; refresh before approving");
    const evidence = await invoke(scope, "reviews.detail", { reviewId: value.review.review.reviewId }) as ReviewDto;
    if (evidence.candidateCommit !== pinned.sourceCommit || evidence.expectedProtectedHead !== pinned.targetCommit || evidence.status === "stale") throw new Error("Review evidence is stale; refresh the pull request");
    if (!active(scope, expected) || selected?.id !== pr.id || currentRevision(selected).id !== pinned.id) throw new Error("The selected revision changed");
    review = evidence; render();
  }
  function render() {
    if (disposed) return;
    const pr = selected, scope = host.scope(), expected = generation;
    const canPrepare = host.has("pull-requests.review");
    const canApprove = host.has("pull-requests.approve");
    const reviewerId = host.reviewerId();
    const currentReview = review;
    const activeApproval = currentReview?.approvals.find(approval => approval.reviewerId === reviewerId
      && !currentReview.revocations.some(revocation => revocation.approvalId === approval.approvalId));
    const props: PullRequestPanelProps = {
      pullRequests: rows, selected: pr, snapshot, onSelect: select,
      reviewStatus: feedback || (review ? `Human review ${review.status} · required reviewers: ${review.requiredReviewerIds.join(", ") || "none"}` : "Prepare this revision to inspect human review and DIM CI requirements."),
      reviewContent: h("div", null,
        currentReview ? h("p", { className: "git-pr__ci-status", "data-ci-state": currentReview.ci?.state ?? "unavailable" }, reviewCiSummary(currentReview.ci)) : null,
        currentReview?.requiredReviewerIds.length && !canApprove && context.operations.some(operation => operation.name === "pull-requests.list")
          ? h("p", null, "Reviewer access is required to approve. ", h("button", { type: "button", onClick: () => window.dispatchEvent(new Event("dim-account-access")) }, "Configure review access")) : null),
      ...(host.has("pull-requests.create") ? { onCreate: async draft => {
        const ref = (value: string) => value.startsWith("refs/") ? value : `refs/heads/${value}`;
        await accept(scope, await invoke(scope, "pull-requests.create", { ...draft, sourceRef: ref(draft.sourceRef), targetRef: ref(draft.targetRef) }), expected);
      } } : {}),
      ...(host.has("diff.read") ? { onInspectDiff: async input => parseDiffSnapshot(await invoke(scope, "diff.read", { ...input })) } : {}),
      ...(host.has("blame.line") ? { onInspectBlame: async input => await invoke(scope, "blame.line", { ...input }) as GitLineAttribution } : {}),
      onRefresh: async () => {
        if (pr) await accept(scope, await invoke(scope, host.has("pull-requests.refresh") ? "pull-requests.refresh" : "pull-requests.detail", host.has("pull-requests.refresh") ? mutationInput(pr) : { pullRequestId: pr.id }), expected);
        else await refresh();
      },
      ...(pr && host.has("pull-requests.update") ? {
        onEdit: async patch => accept(scope, await invoke(scope, "pull-requests.update", { ...mutationInput(pr!), ...patch }), expected),
        onSetState: async state => accept(scope, await invoke(scope, "pull-requests.update", { ...mutationInput(pr!), state }), expected)
      } : {}),
      ...(pr && host.has("pull-requests.comment") ? { onComment: async comment => accept(scope, await invoke(scope, "pull-requests.comment", { ...mutationInput(pr!), ...comment }), expected) } : {}),
      ...(pr && canPrepare ? { onPrepareReview: prepareReview, prepareReviewDisabled: pr.state !== "open" } : {}),
      ...(pr && canApprove ? { onApprove: async () => {
        const evidence = review;
        if (!evidence) throw new Error("Prepare this revision for review before approving");
        if (!window.confirm(`Approve candidate ${evidence.candidateCommit} for ${evidence.protectedRef}?`)) return;
        const value = await invoke(scope, "pull-requests.approve", { ...mutationInput(pr), revisionId: currentRevision(pr).id }) as ReviewDto;
        if (active(scope, expected)) { review = value; render(); }
      }, approveDisabled: pr.state !== "open" || !review || review.status === "approved" } : {}),
      ...(pr && activeApproval && host.has("pull-requests.revoke") ? { onRevoke: async () => {
        if (!review) throw new Error("Refresh the prepared review before revoking approval");
        if (!window.confirm(`Revoke approval for candidate ${review.candidateCommit}?`)) return;
        const value = await invoke(scope, "pull-requests.revoke", { ...mutationInput(pr), revisionId: currentRevision(pr).id }) as ReviewDto;
        if (active(scope, expected)) { review = value; render(); }
      } } : {}),
      ...(pr && host.has("pull-requests.merge") ? { onMerge: async () => {
        const pinned = currentRevision(pr);
        if (!window.confirm(`Merge candidate ${pinned.sourceCommit} into ${pr.targetRef}?`)) return;
        let result: { pullRequest: unknown; review: ReviewDto; refreshPending: boolean };
        try {
          result = await invoke(scope, "pull-requests.merge", { ...mutationInput(pr), revisionId: pinned.id }) as { pullRequest: unknown; review: ReviewDto; refreshPending: boolean };
        } catch (error) {
          await Promise.allSettled([inspect(scope, pr, expected)]);
          throw error;
        }
        if (!active(scope, expected)) return;
        if (result.refreshPending) {
          selected = parsePullRequest(result.pullRequest); review = result.review;
          mergeRefreshPending = true;
          feedback = "Merge accepted. Refresh the pull request to confirm its recorded state."; render(); return;
        }
        await accept(scope, result.pullRequest, expected);
      }, mergeDisabled: mergeRefreshPending || pullRequestMergeDisabled(pr, currentReview) } : {}),
      ...(host.has("blame.line") ? { onBlame: async anchor => await invoke(scope, "blame.line", { commit: anchor.side === "base" ? anchor.baseCommit : anchor.headCommit, path: anchor.path, line: anchor.line }) as GitLineAttribution } : {})
    };
    root.update(props);
  }
  async function refresh() {
    const scope = host.scope(), nextKey = JSON.stringify(scope);
    if (nextKey !== scopeKey) { scopeKey = nextKey; rows = []; selected = null; snapshot = null; review = null; feedback = ""; mergeRefreshPending = false; }
    const expected = ++generation;
    const hasInspection = host.has("diff.read") || host.has("blame.line");
    container.hidden = !scope.repositoryId || (!host.has("pull-requests.list") && !hasInspection);
    if (container.hidden) { root.update({ pullRequests: [], selected: null, snapshot: null }); return; }
    render();
    if (!host.has("pull-requests.list")) return;
    try {
      const values = parsePullRequestList(await invoke(scope, "pull-requests.list"));
      if (!active(scope, expected)) return;
      rows = values; if (selected) selected = rows.find(row => row.id === selected?.id) ?? null;
      render(); if (selected) await inspect(scope, selected, expected);
    } catch { if (active(scope, expected)) { feedback = "Pull requests could not load. Refresh to retry."; render(); } }
  }
  return { refresh, dispose() { disposed = true; ++generation; root.unmount(); for (const link of styles) link.remove(); } };
}
