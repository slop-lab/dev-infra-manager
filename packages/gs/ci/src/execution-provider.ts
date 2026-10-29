import { isDeepStrictEqual } from "node:util";
import {
  ciExecutionEvidenceSchema,
  workflowProviderSchema,
  type CiExecutionEvidence,
} from "@slop-lab/gs-ci-contracts";

export type CiExecutionEvidenceRequest = Pick<CiExecutionEvidence,
  "provider" | "providerRevision" | "eventId" | "reviewId" | "envelopeId"
  | "candidateCommit" | "candidateTree" | "policyDigest">;

export interface CiExecutionProvider {
  readonly name: string;
  readonly revision: string;
  read(request: CiExecutionEvidenceRequest): Promise<unknown>;
}

export type CiEvidenceAttachment = {
  readonly kind: "git-ci";
  readonly id: string;
  readonly digest: string;
};

export async function checkRequiredExecutionEvidence(input: {
  readonly request: CiExecutionEvidenceRequest;
  readonly provider: CiExecutionProvider;
}): Promise<CiEvidenceAttachment> {
  const provider = workflowProviderSchema.parse({
    name: input.provider.name,
    revision: input.provider.revision,
  });
  if (provider.name !== input.request.provider || provider.revision !== input.request.providerRevision) {
    throw new CiExecutionEvidenceError("CI execution provider is stale");
  }
  const value = await input.provider.read(input.request);
  if (value === undefined) throw new CiExecutionEvidenceError("required CI execution evidence is missing");
  const evidence = ciExecutionEvidenceSchema.parse(value);
  const identity: CiExecutionEvidenceRequest = {
    provider: evidence.provider,
    providerRevision: evidence.providerRevision,
    eventId: evidence.eventId,
    reviewId: evidence.reviewId,
    envelopeId: evidence.envelopeId,
    candidateCommit: evidence.candidateCommit,
    candidateTree: evidence.candidateTree,
    policyDigest: evidence.policyDigest,
  };
  if (!isDeepStrictEqual(identity, input.request)) {
    throw new CiExecutionEvidenceError("required CI execution evidence is stale");
  }
  if (evidence.outcome !== "succeeded") {
    throw new CiExecutionEvidenceError("required CI execution evidence failed");
  }
  return { kind: "git-ci", id: evidence.evidenceId, digest: evidence.digest };
}

export class CiExecutionEvidenceError extends Error {
  readonly name = "CiExecutionEvidenceError";
}
