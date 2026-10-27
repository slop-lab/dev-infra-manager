import { afterEach, describe, expect, it } from "vitest";
import { publishedReviewNames, waitForReadyReview } from "../git-ci/nativeBundleReviewFixture.js";
import {
  commit,
  expectRejectedPush,
  finalizedWorkspaceWriteFixture,
  issueWorkspaceWriteLease,
  refValue,
  workspaceId,
  writerClone
} from "./nativeProjectWorkspaceWriteLeaseFixture.js";
import { cleanupFinalizeFixtures, runGit, rootRepository } from "./nativeRootImportFinalizeFixture.js";

afterEach(cleanupFinalizeFixtures);

describe("native Project workspace proposal writes", () => {
  it("pushes only its own proposal through real Git smart HTTP", async () => {
    // Given
    const fixture = await finalizedWorkspaceWriteFixture("workspace-write-happy");
    const lease = await issueWorkspaceWriteLease(fixture.service.origin);
    const clone = await writerClone(fixture.service.origin, lease, "workspace-write-clone");
    await commit(clone, "proposal.txt", "candidate\n");

    // When
    await runGit("/usr/bin/git", ["-C", clone, "push", "origin",
      `HEAD:refs/heads/proposals/${workspaceId}/change-1`]);

    // Then
    const proposal = await refValue(fixture.root, `refs/heads/proposals/${workspaceId}/change-1`);
    expect(proposal).toMatch(/^[0-9a-f]{40}$/);
  });

  it("denies protected, foreign-workspace, deletion, and non-fast-forward legacy proposal writes", async () => {
    // Given
    const fixture = await finalizedWorkspaceWriteFixture("workspace-write-denials");
    const lease = await issueWorkspaceWriteLease(fixture.service.origin);
    const clone = await writerClone(fixture.service.origin, lease, "workspace-write-denial-clone");
    const proposalRef = `refs/heads/proposals/${workspaceId}/change-1`;
    const foreignWorkspaceId = Buffer.alloc(32, 61).toString("base64url");
    const protectedBefore = await refValue(fixture.root, "refs/heads/main");
    await commit(clone, "proposal.txt", "candidate\n");
    await runGit("/usr/bin/git", ["-C", clone, "push", "origin", `HEAD:${proposalRef}`]);
    const proposalBefore = await refValue(fixture.root, proposalRef);
    if (proposalBefore === undefined) throw new Error("accepted proposal ref is missing");
    await waitForReadyReview(rootRepository(fixture.root), proposalBefore);
    const envelopesBefore = await publishedReviewNames(fixture.root);

    // When / Then
    await expectRejectedPush(clone, ["HEAD:refs/heads/main"]);
    await runGit("/usr/bin/git", ["-C", clone, "push", "origin", "HEAD:refs/tags/unreviewed"]);
    await expectRejectedPush(clone, [`HEAD:refs/heads/proposals/${foreignWorkspaceId}/stolen`]);
    await expectRejectedPush(clone, [`:${proposalRef}`]);
    await runGit("/usr/bin/git", ["-C", clone, "checkout", "--orphan", "rewritten-proposal"]);
    await runGit("/usr/bin/git", ["-C", clone, "rm", "-rf", "."]);
    await commit(clone, "replacement.txt", "replacement\n");
    await expectRejectedPush(clone, ["--force", `HEAD:${proposalRef}`]);
    expect(await refValue(fixture.root, "refs/heads/main")).toBe(protectedBefore);
    expect(await refValue(fixture.root, proposalRef)).toBe(proposalBefore);
    expect(await refValue(fixture.root, "refs/tags/unreviewed")).toBe(proposalBefore);
    expect(await refValue(fixture.root, `refs/heads/proposals/${foreignWorkspaceId}/stolen`)).toBeUndefined();
    expect(await publishedReviewNames(fixture.root)).toEqual(envelopesBefore);
  });
});
