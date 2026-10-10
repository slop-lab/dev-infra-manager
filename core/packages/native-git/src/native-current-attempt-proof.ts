import { z } from "zod";
import { deriveAuthoritativeOrdinaryExecutionDescriptor } from "./authoritative-ordinary-execution-descriptor.js";
import { createAuthoritativeOrdinaryAttemptStore } from "./authoritative-ordinary-attempt-store.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import { resolveAuthoritativeNativeRootTarget } from "./authoritative-native-root-target.js";

const digest = z.string().regex(/^[0-9a-f]{64}$/);

export const currentAttemptProofRequestSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().uuid(),
  reviewId: digest,
  executionKind: z.literal("ordinary-sysbox"),
  jobName: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  attemptId: z.string().uuid()
}).strict().readonly();

export async function currentAttemptProof(
  runtime: AuthoritativeNativeCandidateRuntime,
  projectId: string,
  selector: z.infer<typeof currentAttemptProofRequestSchema>
): Promise<Readonly<Record<string, unknown>> | "conflict" | undefined> {
  const target = await resolveAuthoritativeNativeRootTarget(runtime, { projectId });
  const current = await createAuthoritativeOrdinaryAttemptStore(target.repository)
    .current(selector.reviewId, selector.jobName);
  if (current === undefined || current.revocation !== undefined
    || current.attempt.attemptId !== selector.attemptId
    || current.attempt.executionKind !== selector.executionKind) return undefined;
  const attempt = current.attempt;
  const execution = await deriveAuthoritativeOrdinaryExecutionDescriptor(runtime, {
    projectId,
    reviewId: selector.reviewId,
    jobName: selector.jobName,
    trustedCapacity: {
      admissionGeneration: attempt.descriptor.admissionGeneration,
      jobBaseImage: attempt.descriptor.jobImage,
      runnerBaseImage: attempt.descriptor.runnerBaseImage,
      bounds: attempt.descriptor.bounds
    }
  });
  if (execution.digest !== attempt.descriptorDigest
    || JSON.stringify(execution.descriptor) !== JSON.stringify(attempt.descriptor)) return "conflict";
  return {
    schemaVersion: 1,
    serviceId: "native-main",
    requestId: selector.requestId,
    servingGenerationId: runtime.expectedGenerationId,
    projectId,
    repositoryId: "root",
    assignment: attempt
  };
}
