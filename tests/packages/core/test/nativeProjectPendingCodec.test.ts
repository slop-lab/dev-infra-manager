import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NativeProjectPendingRecordError,
  parseNativeProjectPendingRecord
} from "../../../../core/packages/core/src/index.js";
import { compileNativeRootBootstrapPolicy } from "../../../../core/packages/core/src/nativeRootBootstrapPolicy.js";

const reviewPolicy = compileNativeRootBootstrapPolicy({
  rootAlias: "root",
  protectedRef: "refs/heads/main",
  review: {
    requiredReviewerIds: ["owner"],
    pathReviewerRules: [],
    requiredJobs: [{ name: "source", kind: "ordinary-sysbox" }]
  }
}).reviewPolicy;

const record = {
  schemaVersion: 5,
  recordType: "native-project",
  phase: "admission-pending",
  name: "acme",
  projectId: "project-a",
  serviceId: "native-main",
  ownerHostId: "host-a",
  rootRepositoryId: "root",
  rootAlias: "root",
  protectedRef: "refs/heads/main",
  rootCommit: "a".repeat(40),
  rootTree: "b".repeat(40),
  reviewPolicy,
  bundleDigest: "c".repeat(64),
  bundleSize: 123,
  importReceipt: {
    schemaVersion: 1,
    serviceId: "native-main",
    projectId: "project-a",
    rootRepositoryId: "root",
    generationId: "d".repeat(64),
    importNonce: "00000000-0000-4000-8000-000000000000",
    protectedRef: "refs/heads/main",
    expectedCommit: "a".repeat(40),
    policyDigest: createHash("sha256").update(JSON.stringify(reviewPolicy)).digest("hex"),
    bundleDigest: "c".repeat(64),
    bundleSize: 123,
    resolvedTree: "b".repeat(40),
    phase: "root-imported"
  }
} as const;

describe("native Project admission-pending record codec", () => {
  it("parses only the exact schema-5 canonical shape", () => {
    // Given / When
    const parsed = parseNativeProjectPendingRecord(record);

    // Then
    expect(parsed).toEqual(record);
  });

  it.each([
    ["extra top-level field", { ...record, ready: false }],
    ["wrong phase", { ...record, phase: "ready" }],
    ["wrong service", { ...record, serviceId: "foreign-native" }],
    ["changed root commit", { ...record, rootCommit: "e".repeat(40) }],
    ["changed policy digest", { ...record,
      importReceipt: { ...record.importReceipt, policyDigest: "f".repeat(64) } }],
    ["extended receipt", { ...record,
      importReceipt: { ...record.importReceipt, credential: "unexpected" } }]
  ])("rejects a %s", (_label, candidate) => {
    // Given / When / Then
    expect(() => parseNativeProjectPendingRecord(candidate))
      .toThrow(NativeProjectPendingRecordError);
  });
});
