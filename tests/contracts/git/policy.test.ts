import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  repositoryBranchPolicy,
  repositoryBranches,
  repositoryDefaultRef,
  parseRepositoryPolicy,
  repositoryPolicyRevision,
} from "../../../packages/gs/repository-contracts/src/index.js";

describe("managed branch policy", () => {
  it("retains legacy import receipts and their exact policy digest", () => {
    const declaration = { protectedRef: "refs/heads/development", extensions: {} };
    const digest = createHash("sha256").update('dim-repository-policy-v1\0{"extensions":{},"protectedRef":"refs/heads/development"}').digest("hex");
    expect(repositoryPolicyRevision(declaration)).toBe(digest);
    const policy = parseRepositoryPolicy({ schemaVersion: 1, ...declaration, policyRevision: digest });
    expect(repositoryDefaultRef(policy)).toBe(declaration.protectedRef);
    expect(repositoryBranches(policy)).toEqual({ [declaration.protectedRef]: {} });
    expect(() => repositoryBranchPolicy(policy, "refs/heads/main")).toThrow(/not managed/);
  });
  it("binds branch defaults and review choices into the authoritative digest", () => {
    const declaration = { protectedRef: "refs/heads/development", defaultRef: "refs/heads/main", branches: { "refs/heads/main": { review: true }, "refs/heads/development": { review: false } }, extensions: {} };
    const policy = parseRepositoryPolicy({ schemaVersion: 1, ...declaration, policyRevision: repositoryPolicyRevision(declaration) });
    expect(repositoryDefaultRef(policy)).toBe("refs/heads/main");
    expect(repositoryBranchPolicy(policy, "refs/heads/development").review).toBe(false);
    expect(repositoryPolicyRevision({ ...declaration, defaultRef: "refs/heads/development" })).not.toBe(policy.policyRevision);
    expect(() => parseRepositoryPolicy({ ...policy, branches: { "refs/heads/main": { review: true } } })).toThrow();
    expect(() => parseRepositoryPolicy({ ...policy, defaultRef: undefined })).toThrow();
  });
});
