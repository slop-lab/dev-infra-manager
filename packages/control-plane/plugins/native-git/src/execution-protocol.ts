import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { candidateExecutionDescriptorSchema, executionProfileFields } from "./candidate-execution-schema.js";
import { descriptorDigest } from "./candidate-execution.js";
import { authoritativeNativeReviewEventSchema } from "./authoritative-native-review-schema.js";

export const executionDescriptorSchema = candidateExecutionDescriptorSchema;
export const executionDescriptorDigest = descriptorDigest;
export type ExecutionDescriptor = z.infer<typeof executionDescriptorSchema>;
export const executionEventSchema = authoritativeNativeReviewEventSchema;
export type ExecutionEvent = z.infer<typeof executionEventSchema>;
export const executionProfileSchema = z.object({ runnerBaseImage: executionProfileFields.runnerBaseImage,
  jobBaseImage: executionProfileFields.jobBaseImage,
  bounds: executionProfileFields.bounds }).strict().readonly();
export type ExecutionProfile = z.infer<typeof executionProfileSchema>;
export const executionGrantRequestSchema = z.object({ executionId: z.string().uuid(),
  generationId: z.string().regex(/^[0-9a-f]{64}$/), event: executionEventSchema,
  workerId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  slotId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/), profile: executionProfileSchema }).strict().readonly();
export type ExecutionGrantRequest = z.infer<typeof executionGrantRequestSchema>;
export const executionGrantSchema = executionGrantRequestSchema.unwrap().extend({
  attempt: z.number().int().positive(), issuedAt: z.string().datetime(),
  descriptor: candidateExecutionDescriptorSchema,
  descriptorDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/)
}).strict().readonly().superRefine((grant, context) => {
  const descriptor = grant.descriptor;
  if (grant.descriptorDigest !== descriptorDigest(descriptor)
    || descriptor.projectId !== grant.event.projectId || descriptor.repositoryId !== grant.event.repositoryId
    || !isDeepStrictEqual(descriptor.inputs, grant.event.inputs) || descriptor.jobName !== grant.event.jobName
    || descriptor.generationId !== grant.generationId
    || descriptor.runnerBaseImage !== grant.profile.runnerBaseImage || descriptor.jobImage !== grant.profile.jobBaseImage
    || JSON.stringify(descriptor.bounds) !== JSON.stringify(grant.profile.bounds)) {
    context.addIssue({ code: "custom", message: "execution grant does not match its descriptor" });
  }
});
export type ExecutionGrant = z.infer<typeof executionGrantSchema>;
const output = z.object({ bytes: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/), truncated: z.boolean() }).strict().readonly();
const completion = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exited"), exitCode: z.number().int().min(0).max(255) }).strict(),
  z.object({ kind: z.literal("signaled"), signal: z.number().int().positive() }).strict(),
  ...["timed-out", "output-limit-exceeded", "lease-lost", "cancelled"].map((kind) =>
    z.object({ kind: z.literal(kind) }).strict()),
  z.object({ kind: z.literal("executor-failure"), code: z.string().min(1).max(128) }).strict()
]);
export const executionResultSchema = z.object({ executionId: z.string().uuid(),
  descriptorDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/), cleanupComplete: z.literal(true),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  result: z.enum(["success", "failure", "cancelled"]), completion, stdout: output, stderr: output
}).strict().readonly().superRefine((result, context) => {
  const exited = result.completion.kind === "exited" && "exitCode" in result.completion && result.completion.exitCode === 0;
  if ((result.result === "success") !== exited || (result.result === "cancelled") !== (result.completion.kind === "cancelled") || Date.parse(result.finishedAt) < Date.parse(result.startedAt)) {
    context.addIssue({ code: "custom", message: "execution result is inconsistent" });
  }
});
export type ExecutionResult = z.infer<typeof executionResultSchema>;

export const executionCredentialSchema = z.object({ username: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  password: z.string().regex(/^[A-Za-z0-9_-]{43,}$/).refine((value) => Buffer.from(value, "base64url").toString("base64url") === value)
}).strict().readonly();
export const executionSourceCredentialsSchema = z.object({ grantIssuer: executionCredentialSchema,
  candidateReader: executionCredentialSchema, resultReporter: executionCredentialSchema }).strict();
