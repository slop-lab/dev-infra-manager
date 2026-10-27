import { mountPullRequestPanel, type CommentDraft, type PullRequestDraft } from "@slop-lab/gs-react-pull-requests";
import { parsePullRequest, type PullRequest } from "@slop-lab/gs-pull-requests";
import { parseGitDiff } from "@slop-lab/gs-diff";
const baseCommit = "a".repeat(40), headCommit = "b".repeat(40), now = "2026-01-01T00:00:00.000Z";
const first = parsePullRequest({ schemaVersion: 1, id: "a:b", version: 1, title: "First request", body: "", sourceRef: "refs/heads/feature", targetRef: "refs/heads/main", state: "open", actorId: "author", createdAt: now, updatedAt: now, comments: [], revisions: [{ id: "c", sourceCommit: headCommit, targetCommit: baseCommit, createdAt: now }] });
const second = parsePullRequest({ ...first, id: "a", title: "Second request", revisions: [{ ...first.revisions[0]!, id: "b:c" }] });
const snapshot = parseGitDiff("diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n", { baseCommit, headCommit });
let selected: PullRequest = first, release: (() => void) | undefined;
let createScope: string | null = null;
const createDrafts = new Map<string, PullRequestDraft>();
export const created: Array<{ scope: string; draft: PullRequestDraft }> = [];
export const observedDrafts: PullRequestDraft[] = [];
export const submitted: CommentDraft[] = [];
const container = document.querySelector("main"); if (!container) throw new Error("Missing fixture container");
const panel = mountPullRequestPanel(container, props());
function props() {
  if (createScope === "observer") return { pullRequests: [], selected: null, snapshot: null, createScopeKey: createScope,
    onCreateDraftChange(draft: PullRequestDraft) { observedDrafts.push(draft); },
    async onCreate(draft: PullRequestDraft) { created.push({ scope: "observer", draft }); } };
  if (createScope) {
    const scope = createScope, targetRefs = scope === "alpha" ? ["refs/heads/release", "refs/heads/staging"] : ["refs/heads/main"];
    return { pullRequests: [], selected: null, snapshot: null, createScopeKey: scope, targetRefs,
      createDraft: createDrafts.get(scope) ?? { title: "", body: "", sourceRef: "", targetRef: targetRefs[0]! },
      onCreateDraftChange(draft: PullRequestDraft) { createDrafts.set(scope, draft); panel.update(props()); },
      async onCreate(draft: PullRequestDraft) { created.push({ scope, draft }); createDrafts.delete(scope); panel.update(props()); } };
  }
  return { pullRequests: [first, second], selected, snapshot,
    async onInspectDiff() { return snapshot; },
    async onInspectBlame() { return { commit: headCommit, path: "file", line: 1, author: "DIM Journey", summary: "direct inspection" }; },
    onComment: async (input: CommentDraft) => {
    submitted.push(input);
    selected = parsePullRequest({ ...selected, comments: [...selected.comments, { ...input, id: `comment-${submitted.length}`, actorId: "reviewer", createdAt: now }] });
    panel.update(props());
    await new Promise<void>(resolve => { release = resolve; });
  } };
}
export function selectSecond(): void { selected = second; panel.update(props()); }
export function releaseComment(): void { release?.(); release = undefined; }
export function selectCreateScope(scope: "alpha" | "beta" | "observer"): void { createScope = scope; panel.update(props()); }
