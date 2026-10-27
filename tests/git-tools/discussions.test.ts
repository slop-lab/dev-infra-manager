import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appendDiscussionComment,
  commentIsOutdated,
  parseDiscussionAnchor,
  parseDiscussionComment,
} from "@slop-lab/gs-discussions";

const createdAt = "2026-10-25T00:00:00.000Z";

function comment(revisionId = "revision-1") {
  return parseDiscussionComment({
    id: randomUUID(),
    revisionId,
    actorId: "reviewer",
    body: "Explain this line",
    createdAt,
    anchor: { path: "src/index.ts", side: "head", line: 7 },
  });
}

describe("portable Git discussions", () => {
  it("appends a validated comment without mutating the source list", () => {
    const original = [comment()];
    const added = comment();

    const result = appendDiscussionComment(original, added);

    expect(result).toEqual([...original, added]);
    expect(original).toHaveLength(1);
  });

  it("rejects duplicate comment identifiers", () => {
    const existing = comment();
    const duplicate = parseDiscussionComment({ ...existing, body: "Duplicate" });

    expect(() => appendDiscussionComment([existing], duplicate)).toThrow();
  });

  it("reports whether a comment belongs to an older revision", () => {
    const existing = comment("revision-1");

    expect(commentIsOutdated(existing, "revision-2")).toBe(true);
    expect(commentIsOutdated(existing, "revision-1")).toBe(false);
  });

  it("rejects anchors that can escape a repository-relative path", () => {
    expect(() => parseDiscussionAnchor({ path: "../secret", side: "head", line: 1 })).toThrow();
    expect(() => parseDiscussionAnchor({ path: "src/index.ts", side: "head", line: 1 })).not.toThrow();
  });
});
