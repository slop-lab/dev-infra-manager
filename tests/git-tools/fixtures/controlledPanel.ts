import { mountPullRequestPanel, type CommentDraft } from "@slop-lab/react-git-pull-requests";
import { parsePullRequest, type PullRequest } from "@slop-lab/git-pull-requests";
import { parseGitDiff } from "@slop-lab/git-diff";
const baseCommit = "a".repeat(40), headCommit = "b".repeat(40), now = "2026-01-01T00:00:00.000Z";
const first = parsePullRequest({ schemaVersion: 1, id: "a:b", version: 1, title: "First request", body: "", sourceRef: "feature", targetRef: "main", state: "open", actorId: "author", createdAt: now, updatedAt: now, comments: [], revisions: [{ id: "c", sourceCommit: headCommit, targetCommit: baseCommit, createdAt: now }] });
const second = parsePullRequest({ ...first, id: "a", title: "Second request", revisions: [{ ...first.revisions[0]!, id: "b:c" }] });
const snapshot = parseGitDiff("diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n", { baseCommit, headCommit });
let selected: PullRequest = first, release: (() => void) | undefined;
export const submitted: CommentDraft[] = [];
const container = document.querySelector("main"); if (!container) throw new Error("Missing fixture container");
const panel = mountPullRequestPanel(container, props());
function props() {
  return { pullRequests: [first, second], selected, snapshot, onComment: async (input: CommentDraft) => {
    submitted.push(input);
    selected = parsePullRequest({ ...selected, comments: [...selected.comments, { ...input, id: `comment-${submitted.length}`, actorId: "reviewer", createdAt: now }] });
    panel.update(props());
    await new Promise<void>(resolve => { release = resolve; });
  } };
}
export function selectSecond(): void { selected = second; panel.update(props()); }
export function releaseComment(): void { release?.(); release = undefined; }
