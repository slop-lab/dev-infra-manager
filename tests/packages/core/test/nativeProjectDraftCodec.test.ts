import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseNativeProjectDraft, NativeProjectDraftError } from "../../../../core/packages/core/src/nativeProjectDraftCodec.js";
import { compileNativeRootBootstrapPolicy } from "../../../../core/packages/core/src/nativeRootBootstrapPolicy.js";

const compiled = compileNativeRootBootstrapPolicy({ rootAlias: "root", protectedRef: "refs/heads/main",
  review: { requiredReviewerIds: ["owner"], pathReviewerRules: [],
    requiredJobs: [{ name: "source", kind: "ordinary-sysbox" }, { name: "integration", kind: "qemu" }] } });
const changedKindJobs = [
  { name: "integration", kind: "qemu", evidenceClass: "candidate-controlled" },
  { name: "source", kind: "qemu", evidenceClass: "candidate-controlled" }
] as const;
const pending = {
  schemaVersion: 2, recordType: "native-project-draft", phase: "import-pending", name: "acme",
  projectId: "project-a", serviceId: "native-main", ownerHostId: "host-a", generationId: "a".repeat(64),
  rootRepositoryId: "root", rootAlias: compiled.rootAlias, protectedRef: compiled.protectedRef,
  expectedCommit: "b".repeat(40), expectedTree: "c".repeat(40),
  reviewPolicy: compiled.reviewPolicy,
  bundleDigest: "d".repeat(64), bundleSize: 123
} as const;
const importReceipt = {
  schemaVersion: 1, serviceId: "native-main", projectId: pending.projectId, rootRepositoryId: "root",
  generationId: pending.generationId, importNonce: "00000000-0000-4000-8000-000000000000",
  protectedRef: pending.protectedRef, expectedCommit: pending.expectedCommit,
  policyDigest: createHash("sha256").update(JSON.stringify(compiled.reviewPolicy)).digest("hex"),
  bundleDigest: pending.bundleDigest, bundleSize: pending.bundleSize,
  resolvedTree: pending.expectedTree, phase: "root-imported"
} as const;

describe("native Project draft codec", () => {
  it("accepts only exact schema-2 pending and receipt-bound imported records", () => {
    expect(parseNativeProjectDraft(pending)).toEqual(pending);
    expect(parseNativeProjectDraft(pending)).not.toHaveProperty("requiredJobs");
    const imported = { ...pending, phase: "root-imported", importReceipt };
    expect(parseNativeProjectDraft(imported)).toEqual(imported);
  });

  it("rejects ready, Gitea state, unknown fields, changed required job kinds, and an unbound receipt", () => {
    for (const invalid of [
      { ...pending, phase: "ready" },
      { ...pending, giteaOrganizationId: 7 },
      { ...pending, credential: "secret" },
      { ...pending, reviewPolicy: { ...pending.reviewPolicy, requiredJobs: changedKindJobs } },
      { ...pending, phase: "root-imported" },
      { ...pending, importReceipt },
      { ...pending, phase: "root-imported", importReceipt: { ...importReceipt, resolvedTree: "e".repeat(40) } },
      { ...pending, phase: "root-imported", importReceipt: { ...importReceipt, policyDigest: "f".repeat(64) } },
      { ...pending, phase: "root-imported", importReceipt: { ...importReceipt, generationId: "f".repeat(64) } }
    ]) expect(() => parseNativeProjectDraft(invalid)).toThrow(NativeProjectDraftError);
  });

  it("accepts completed legacy schema-1 drafts only as immutable proof data", () => {
    const legacyJobs = [
      { name: "integration", kind: "qemu" }, { name: "source", kind: "ordinary-sysbox" }
    ] as const;
    const legacyReviewers = { requiredReviewerIds: ["owner"], pathReviewerRules: [] } as const;
    const legacyPolicy = {
      protectedRef: "refs/heads/main", policyRevision: createHash("sha256")
        .update("dim-native-policy-v1\0").update(JSON.stringify({
          protectedRef: "refs/heads/main", ...legacyReviewers, requiredJobs: legacyJobs
        })).digest("hex"),
      requiredReviewRevision: createHash("sha256").update("dim-native-reviewers-v1\0")
        .update(JSON.stringify(legacyReviewers)).digest("hex"),
      requiredJobSetRevision: createHash("sha256").update("dim-native-jobs-v1\0")
        .update(JSON.stringify(legacyJobs)).digest("hex"),
      requiredJobNames: ["integration", "source"], requiredReviewerIds: ["owner"], pathReviewerRules: []
    } as const;
    const legacyBase = { ...pending, schemaVersion: 1, requiredJobs: legacyJobs, reviewPolicy: legacyPolicy } as const;
    const legacyReceipt = { ...importReceipt,
      policyDigest: createHash("sha256").update(JSON.stringify(legacyPolicy)).digest("hex") };

    expect(parseNativeProjectDraft({ ...legacyBase, phase: "root-imported",
      importReceipt: legacyReceipt })).toEqual({ ...legacyBase, phase: "root-imported", importReceipt: legacyReceipt });
    expect(() => parseNativeProjectDraft({ ...legacyBase, phase: "import-pending" }))
      .toThrow(NativeProjectDraftError);
  });
});
