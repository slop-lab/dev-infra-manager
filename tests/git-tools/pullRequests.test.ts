import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { commentIsOutdated } from "@slop-lab/gs-discussions";
import { appendComment, appendRevision, currentRevision, markMerged, parsePullRequest, PullRequestConflict, updatePullRequest } from "@slop-lab/gs-pull-requests";
const now = "2026-10-23T00:00:00.000Z";
function fixture() { return parsePullRequest({ schemaVersion: 1, id: randomUUID(), version: 1, title: "First PR", body: "", sourceRef: "refs/heads/change", targetRef: "refs/heads/main", state: "open", actorId: "alice", createdAt: now, updatedAt: now, revisions: [{ id: randomUUID(), sourceCommit: "a".repeat(40), targetCommit: "b".repeat(40), createdAt: now }], comments: [] }); }
describe("portable pull requests", () => {
  it("keeps identity and immutable comment anchors across pushes", () => {
    const pr = fixture();
    const comment = { id: randomUUID(), revisionId: currentRevision(pr).id, actorId: "bob", body: "Explain this", createdAt: now, anchor: { path: "src/a.ts", side: "head" as const, line: 7 } };
    const discussed = appendComment(pr, 1, comment);
    const pushed = appendRevision(discussed, 2, { id: randomUUID(), sourceCommit: "c".repeat(40), targetCommit: "b".repeat(40), createdAt: now });
    expect(pushed.id).toBe(pr.id); expect(pushed.revisions[0]).toEqual(pr.revisions[0]);
    expect(pushed.comments[0]).toEqual(comment); expect(commentIsOutdated(comment, currentRevision(pushed).id)).toBe(true);
    expect(pr.version).toBe(1); expect(pr.comments).toEqual([]);
  });
  it("rejects stale writes, foreign revisions and edits after merge", () => {
    const pr = fixture();
    expect(() => updatePullRequest(pr, 2, { title: "Lost write" }, now)).toThrow(PullRequestConflict);
    expect(() => appendComment(pr, 1, { id: randomUUID(), revisionId: randomUUID(), actorId: "bob", body: "No", createdAt: now })).toThrow(PullRequestConflict);
    const merged = markMerged(pr, 1, now);
    expect(() => updatePullRequest(merged, 2, { state: "open" }, now)).toThrow(PullRequestConflict);
    expect(() => appendRevision(updatePullRequest(pr, 1, { state: "closed" }, now), 2, { ...currentRevision(pr), id: randomUUID() })).toThrow(PullRequestConflict);
  });
  it("rejects hostile paths and unknown authority fields", () => {
    const pr = fixture();
    expect(() => parsePullRequest({ ...pr, approved: true })).toThrow();
    expect(() => appendComment(pr, 1, { id: randomUUID(), revisionId: currentRevision(pr).id, actorId: "bob", body: "No", createdAt: now, anchor: { path: "../secret", side: "head", line: 1 } })).toThrow();
    expect(() => parsePullRequest({ ...pr, sourceRef: "refs/remotes/origin/change" })).toThrow();
  });
  it("accepts ordinary branch, tag and legacy proposal sources", () => {
    const pr = fixture();
    const workspaceId = Buffer.alloc(32, 9).toString("base64url");
    for (const sourceRef of ["refs/heads/feature/review", "refs/tags/v1.0.0", `refs/heads/proposals/${workspaceId}/change`]) {
      expect(parsePullRequest({ ...pr, sourceRef }).sourceRef).toBe(sourceRef);
    }
  });
});

it("accepts another Git service's opaque identifiers without DIM conventions", () => {
  const value = fixture();
  const pr = parsePullRequest({ ...value, id: "42", revisions: [{ ...currentRevision(value), id: "comparison-abc" }] });
  const discussed = appendComment(pr, 1, { id: "comment-123", revisionId: "comparison-abc", actorId: "external-user", body: "A portable comment", createdAt: now });
  expect(discussed.id).toBe("42"); expect(discussed.comments[0]?.revisionId).toBe("comparison-abc");
  expect(() => parsePullRequest({ ...discussed, revisions: [...discussed.revisions, { ...currentRevision(discussed), sourceCommit: "c".repeat(40) }] })).toThrow();
});
