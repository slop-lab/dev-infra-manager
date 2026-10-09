import { z } from "zod";
import {
  loadAuthoritativeExecutionReview,
  loadCurrentAuthoritativeExecutionInputs
} from "./authoritative-execution-review-inputs.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import { descriptorDigest } from "./candidate-execution.js";
import {
  candidateOrdinaryExecutionDescriptorSchema,
  CandidateExecutionError,
  ordinaryExecutionDescriptorRequestFields,
  type CandidateOrdinaryExecutionDescriptor
} from "./candidate-execution-schema.js";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const trustedCapacitySchema = z.object({
  admissionGeneration: ordinaryExecutionDescriptorRequestFields.admissionGeneration,
  jobBaseImage: ordinaryExecutionDescriptorRequestFields.jobBaseImage,
  runnerBaseImage: ordinaryExecutionDescriptorRequestFields.runnerBaseImage,
  bounds: ordinaryExecutionDescriptorRequestFields.bounds
}).strict().readonly();
const requestSchema = z.object({
  projectId: identifier,
  reviewId: z.string().regex(/^[0-9a-f]{64}$/),
  jobName: ordinaryExecutionDescriptorRequestFields.jobName,
  trustedCapacity: trustedCapacitySchema
}).strict().readonly();

export type AuthoritativeOrdinaryExecutionDescriptor = {
  readonly kind: "ordinary-sysbox";
  readonly reviewId: string;
  readonly descriptor: CandidateOrdinaryExecutionDescriptor;
  readonly digest: string;
};

export async function deriveAuthoritativeOrdinaryExecutionDescriptor(
  runtime: AuthoritativeNativeCandidateRuntime,
  input: unknown
): Promise<AuthoritativeOrdinaryExecutionDescriptor> {
  try {
    const request = requestSchema.safeParse(input);
    if (!request.success) {
      throw new CandidateExecutionError("authoritative ordinary execution descriptor request is invalid", {
        cause: request.error
      });
    }
    const snapshot = await loadAuthoritativeExecutionReview(runtime, request.data);
    const requiredJob = snapshot.envelope.review.requiredJobs.find(({ jobName }) => jobName === request.data.jobName);
    if (requiredJob?.executionKind !== "ordinary-sysbox") {
      throw new CandidateExecutionError("authoritative review job is not ordinary-sysbox");
    }
    const { inputs, review } = await loadCurrentAuthoritativeExecutionInputs(runtime, snapshot);
    const selected = inputs.plan.find(({ name }) => name === request.data.jobName);
    if (selected?.kind !== "ordinary-sysbox") {
      throw new CandidateExecutionError("authoritative candidate job is not ordinary-sysbox");
    }
    const descriptor = candidateOrdinaryExecutionDescriptorSchema.parse({
      admissionGeneration: request.data.trustedCapacity.admissionGeneration,
      jobName: request.data.jobName,
      runnerBaseImage: request.data.trustedCapacity.runnerBaseImage,
      bounds: request.data.trustedCapacity.bounds,
      projectId: review.projectId,
      repositoryId: review.repositoryId,
      protectedRef: review.protectedRef,
      expectedProtectedHead: review.expectedProtectedHead,
      candidateCommit: review.candidateCommit,
      candidateTree: review.candidateTree,
      policyRevision: review.policyRevision,
      requiredReviewRevision: review.requiredReviewRevision,
      requiredJobSetRevision: review.requiredJobSetRevision,
      evidenceClass: "candidate-controlled",
      configBlob: inputs.configBlob,
      script: selected.script,
      argv: selected.argv,
      jobImage: request.data.trustedCapacity.jobBaseImage
    });
    return {
      kind: "ordinary-sysbox",
      reviewId: review.reviewId,
      descriptor,
      digest: descriptorDigest(descriptor)
    };
  } catch (error) {
    if (error instanceof CandidateExecutionError) throw error;
    throw new CandidateExecutionError("authoritative ordinary execution descriptor could not be derived", {
      cause: error
    });
  }
}
