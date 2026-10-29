import { describe, expect, it } from "vitest";
import * as ciContracts from "../../../packages/gs/ci-contracts/src/index.js";

describe("portable GS CI provider contracts", () => {
  it("parses revision-bound execution evidence without a DIM execution profile", () => {
    const schema = Reflect.get(ciContracts, "ciExecutionEvidenceSchema");

    expect(schema).toBeDefined();
    expect(schema.parse({
      schemaVersion: 1,
      provider: "portable",
      providerRevision: "a".repeat(64),
      eventId: "b".repeat(64),
      reviewId: "c".repeat(64),
      envelopeId: "d".repeat(64),
      candidateCommit: "e".repeat(40),
      candidateTree: "f".repeat(40),
      policyDigest: "1".repeat(64),
      outcome: "succeeded",
      evidenceId: "portable:run-1",
      digest: "2".repeat(64),
    })).toMatchObject({ provider: "portable", outcome: "succeeded" });
  });

  it("exposes a workflow-provider revision separate from DIM compiler registration", () => {
    const schema = Reflect.get(ciContracts, "workflowProviderSchema");

    expect(schema).toBeDefined();
    expect(schema.parse({ name: "portable", revision: "a".repeat(64) })).toEqual({
      name: "portable",
      revision: "a".repeat(64),
    });
  });
});
