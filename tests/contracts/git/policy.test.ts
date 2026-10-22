import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { nativeRepositoryBranchPolicy, nativeRepositoryBranches, nativeRepositoryDefaultRef, nativeRepositoryPolicyRevision, parseAuthoritativeImportedRootPolicy } from "../../../packages/contracts/git/src/index.js";

describe("managed branch policy", () => {
  it("retains legacy import receipts and their exact policy digest", () => {
    const declaration = { protectedRef: "refs/heads/development", extensions: {} };
    const digest = createHash("sha256").update('dim-repository-policy-v1\0{"extensions":{},"protectedRef":"refs/heads/development"}').digest("hex");
    expect(nativeRepositoryPolicyRevision(declaration)).toBe(digest);
    const policy = parseAuthoritativeImportedRootPolicy({ schemaVersion: 1, ...declaration, policyRevision: digest });
    expect(nativeRepositoryDefaultRef(policy)).toBe(declaration.protectedRef);
    expect(nativeRepositoryBranches(policy)).toEqual({ [declaration.protectedRef]: { review: true } });
    expect(() => nativeRepositoryBranchPolicy(policy, "refs/heads/main")).toThrow(/not managed/);
  });
  it("binds branch defaults and review choices into the authoritative digest", () => {
    const declaration = { protectedRef: "refs/heads/development", defaultRef: "refs/heads/main", branches: { "refs/heads/main": { review: true }, "refs/heads/development": { review: false } }, extensions: {} };
    const policy = parseAuthoritativeImportedRootPolicy({ schemaVersion: 1, ...declaration, policyRevision: nativeRepositoryPolicyRevision(declaration) });
    expect(nativeRepositoryDefaultRef(policy)).toBe("refs/heads/main");
    expect(nativeRepositoryBranchPolicy(policy, "refs/heads/development").review).toBe(false);
    expect(nativeRepositoryPolicyRevision({ ...declaration, defaultRef: "refs/heads/development" })).not.toBe(policy.policyRevision);
    expect(() => parseAuthoritativeImportedRootPolicy({ ...policy, branches: { "refs/heads/main": { review: true } } })).toThrow();
    expect(() => parseAuthoritativeImportedRootPolicy({ ...policy, defaultRef: undefined })).toThrow();
  });
});
