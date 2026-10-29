import { describe, expect, it } from "vitest";
import {
  candidatePrincipalId,
  classifyCandidateRef,
  isCandidateRef,
  isLegacyProposalRef,
  isLegacyWorkspaceProposalRef,
  isOrdinaryCandidateRef
} from "../../../packages/gs/repository-contracts/src/index.js";

const workspaceId = Buffer.alloc(32, 7).toString("base64url");

describe("native Git candidate refs", () => {
  it("classifies canonical ordinary branches and tags", () => {
    // Given / When / Then
    expect(classifyCandidateRef("refs/heads/topic/one", workspaceId)).toEqual({
      kind: "ordinary",
      ref: "refs/heads/topic/one"
    });
    expect(isOrdinaryCandidateRef("refs/tags/v1.2.3")).toBe(true);
    expect(isCandidateRef("refs/tags/v1.2.3")).toBe(true);
    expect(candidatePrincipalId("refs/tags/v1.2.3")).toBeUndefined();
  });

  it("recognizes only the authenticated workspace legacy proposal namespace", () => {
    // Given
    const own = `refs/heads/proposals/${workspaceId}/change`;
    const foreign = `refs/heads/proposals/${Buffer.alloc(32, 8).toString("base64url")}/change`;

    // When / Then
    expect(isLegacyWorkspaceProposalRef(own, workspaceId)).toBe(true);
    expect(isCandidateRef(own)).toBe(true);
    expect(isLegacyProposalRef(own)).toBe(true);
    expect(candidatePrincipalId(own)).toBe(workspaceId);
    expect(classifyCandidateRef(foreign, workspaceId)).toEqual({ kind: "reserved", ref: foreign });
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
      expect(isOrdinaryCandidateRef(ref)).toBe(false);
      expect(candidatePrincipalId(ref)).toBeUndefined();
    }
  });
});
