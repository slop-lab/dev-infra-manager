import { z } from "zod";
import {
  loadAuthoritativeExecutionReview,
  loadCurrentAuthoritativeExecutionInputs
} from "./authoritative-execution-review-inputs.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import {
  CandidateExecutionError,
  ordinaryExecutionDescriptorRequestFields
} from "./candidate-execution-schema.js";
import {
  qemuExecutionDescriptorDigest,
  qemuExecutionDescriptorSchema,
  type QemuExecutionDescriptor
} from "./qemu-execution-descriptor.js";

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

export type AuthoritativeQemuExecutionDescriptor = {
  readonly kind: "qemu";
  readonly reviewId: string;
  readonly descriptor: QemuExecutionDescriptor;
  readonly digest: string;
};

export async function deriveAuthoritativeQemuExecutionDescriptor(
  runtime: AuthoritativeNativeCandidateRuntime,
  input: unknown
): Promise<AuthoritativeQemuExecutionDescriptor> {
  try {
    const request = requestSchema.safeParse(input);
    if (!request.success) {
      throw new CandidateExecutionError("authoritative QEMU execution descriptor request is invalid", {
        cause: request.error
      });
    }
    const snapshot = await loadAuthoritativeExecutionReview(runtime, request.data);
    const requiredJob = snapshot.envelope.review.requiredJobs
      .find(({ jobName }) => jobName === request.data.jobName);
    if (requiredJob?.executionKind !== "qemu") {
      throw new CandidateExecutionError("authoritative review job is not qemu");
    }
    const { inputs, review } = await loadCurrentAuthoritativeExecutionInputs(runtime, snapshot);
    const selected = inputs.plan.find(({ name }) => name === request.data.jobName);
    if (selected?.kind !== "qemu") {
      throw new CandidateExecutionError("authoritative candidate job is not qemu");
    }
    const descriptor = qemuExecutionDescriptorSchema.parse({
      schemaVersion: 1,
      executionKind: "qemu",
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
      kind: "qemu",
      reviewId: review.reviewId,
      descriptor,
      digest: qemuExecutionDescriptorDigest(descriptor)
    };
  } catch (error) {
    if (error instanceof CandidateExecutionError) throw error;
    throw new CandidateExecutionError("authoritative QEMU execution descriptor could not be derived", {
      cause: error
    });
  }
}
