import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseNativeProjectDraft, NativeProjectDraftError } from "../../../../core/packages/managed/src/nativeProjectDraftCodec.js";
import { compileNativeRepositoryBootstrapPolicy } from "../../../../core/packages/managed/src/nativeRootBootstrapPolicy.js";

const compiled = compileNativeRepositoryBootstrapPolicy({ repositoryId: "root", protectedRef: "refs/heads/main",
  review: { ciRepositoryIds: ["root"], requiredReviewerIds: ["owner"], pathReviewerRules: [],
    requiredJobs: [{ name: "source", kind: "ordinary-sysbox" }, { name: "integration", kind: "qemu" }] } });
const changedKindJobs = [
  { name: "integration", kind: "qemu", evidenceClass: "candidate-controlled" },
  { name: "source", kind: "qemu", evidenceClass: "candidate-controlled" }
] as const;
const pending = {
  schemaVersion: 3, recordType: "native-project-draft", phase: "import-pending", name: "acme",
  projectId: "project-a", serviceId: "native-main", ownerHostId: "host-a", generationId: "a".repeat(64),
  repositoryId: compiled.repositoryId, protectedRef: compiled.protectedRef,
  expectedCommit: "b".repeat(40), expectedTree: "c".repeat(40),
  reviewPolicy: compiled.reviewPolicy,
  bundleDigest: "d".repeat(64), bundleSize: 123
} as const;
const importReceipt = {
  schemaVersion: 1, serviceId: "native-main", projectId: pending.projectId, repositoryId: "root",
  generationId: pending.generationId, importNonce: "00000000-0000-4000-8000-000000000000",
  protectedRef: pending.protectedRef, expectedCommit: pending.expectedCommit,
  policyDigest: createHash("sha256").update(JSON.stringify(compiled.reviewPolicy)).digest("hex"),
  bundleDigest: pending.bundleDigest, bundleSize: pending.bundleSize,
  resolvedTree: pending.expectedTree, phase: "repository-imported"
} as const;

describe("native Project draft codec", () => {
  it("accepts only exact schema-3 pending and receipt-bound imported records", () => {
    expect(parseNativeProjectDraft(pending)).toEqual(pending);
    expect(parseNativeProjectDraft(pending)).not.toHaveProperty("requiredJobs");
    const imported = { ...pending, phase: "repository-imported", importReceipt };
    expect(parseNativeProjectDraft(imported)).toEqual(imported);
  });

  it("rejects ready, Gitea state, unknown fields, changed required job kinds, and an unbound receipt", () => {
    for (const invalid of [
      { ...pending, phase: "ready" },
      { ...pending, giteaOrganizationId: 7 },
      { ...pending, credential: "secret" },
      { ...pending, reviewPolicy: { ...pending.reviewPolicy, requiredJobs: changedKindJobs } },
      { ...pending, phase: "repository-imported" },
      { ...pending, importReceipt },
      { ...pending, phase: "repository-imported", importReceipt: { ...importReceipt, resolvedTree: "e".repeat(40) } },
      { ...pending, phase: "repository-imported", importReceipt: { ...importReceipt, policyDigest: "f".repeat(64) } },
      { ...pending, phase: "repository-imported", importReceipt: { ...importReceipt, generationId: "f".repeat(64) } }
    ]) expect(() => parseNativeProjectDraft(invalid)).toThrow(NativeProjectDraftError);
  });

  it("rejects obsolete draft schemas in every phase", () => {
    for (const phase of ["import-pending", "repository-imported"]) {
      expect(() => parseNativeProjectDraft({ ...pending, schemaVersion: 1, phase, importReceipt }))
        .toThrow(NativeProjectDraftError);
    }
  });
});
