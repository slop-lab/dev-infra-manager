import { describe, expect, it } from "vitest";
import {
  classifyNativeGitCandidateRef,
  isNativeGitCandidateRef,
  isNativeGitLegacyProposalRef,
  isNativeGitLegacyWorkspaceProposalRef,
  isNativeGitOrdinaryCandidateRef,
  nativeGitCandidateWorkspaceId
} from "@slop-lab/dim-contracts-git";

const workspaceId = Buffer.alloc(32, 7).toString("base64url");

describe("native Git candidate refs", () => {
  it("classifies canonical ordinary branches and tags", () => {
    // Given / When / Then
    expect(classifyNativeGitCandidateRef("refs/heads/topic/one", workspaceId)).toEqual({
      kind: "ordinary",
      ref: "refs/heads/topic/one"
    });
    expect(isNativeGitOrdinaryCandidateRef("refs/tags/v1.2.3")).toBe(true);
    expect(isNativeGitCandidateRef("refs/tags/v1.2.3")).toBe(true);
    expect(nativeGitCandidateWorkspaceId("refs/tags/v1.2.3")).toBeUndefined();
  });

  it("recognizes only the authenticated workspace legacy proposal namespace", () => {
    // Given
    const own = `refs/heads/proposals/${workspaceId}/change`;
    const foreign = `refs/heads/proposals/${Buffer.alloc(32, 8).toString("base64url")}/change`;

    // When / Then
    expect(isNativeGitLegacyWorkspaceProposalRef(own, workspaceId)).toBe(true);
    expect(isNativeGitCandidateRef(own)).toBe(true);
    expect(isNativeGitLegacyProposalRef(own)).toBe(true);
    expect(nativeGitCandidateWorkspaceId(own)).toBe(workspaceId);
    expect(classifyNativeGitCandidateRef(foreign, workspaceId)).toEqual({ kind: "reserved", ref: foreign });
  });

  it("never admits reserved or malformed refs as ordinary", () => {
    // Given / When / Then
    for (const ref of [
      "refs/heads/proposals/short/change",
      "refs/heads/proposals",
      "refs/dim/extensions/review/pin",
      "refs/remotes/upstream/main",
      "refs/heads/.hidden",
      "refs/tags/release..candidate"
    ]) {
      expect(isNativeGitOrdinaryCandidateRef(ref)).toBe(false);
      expect(nativeGitCandidateWorkspaceId(ref)).toBeUndefined();
    }
  });
});
