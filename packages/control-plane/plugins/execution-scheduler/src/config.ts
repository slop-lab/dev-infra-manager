import { z } from "zod";
import { executionCredentialSchema, executionTaskSlotSchema, executionServiceBaseConfigSchema,
  executionWorkerRegistrationBaseSchema } from "@slop-lab/dim-contracts-execution/config";
import { ciExecutionSourceSchema, ciExecutionCredentialsSchema, ciServiceSlotSchema } from "@slop-lab/dim-contracts-ci/config";

/** The deployed scheduler explicitly composes generic execution and optional CI admission. */
export const executionServiceConfigSchema = executionServiceBaseConfigSchema.extend({
  nativeGit: ciExecutionSourceSchema.optional(),
  credentials: executionServiceBaseConfigSchema.shape.credentials.extend(ciExecutionCredentialsSchema.shape).readonly(),
  workers: z.array(executionWorkerRegistrationBaseSchema.extend({
    slots: z.array(z.union([ciServiceSlotSchema, executionTaskSlotSchema])).min(1).readonly()
  }).strict().readonly()).readonly()
}).strict().readonly().superRefine((config, context) => {
  const roles = [...Object.values(config.credentials).filter((value) => value !== undefined), ...Object.entries(config.nativeGit ?? {})
    .filter(([key]) => key !== "endpoint").map(([, value]) => value as z.infer<typeof executionCredentialSchema>),
    ...config.workers.map((worker) => ({ username: worker.id, password: worker.token }))];
  const values = roles.flatMap((role) => [role.username, role.password]);
  if (new Set(values).size !== values.length || config.workers.some((worker) =>
    new Set(worker.slots.map((slot) => slot.id)).size !== worker.slots.length)) {
    context.addIssue({ code: "custom", message: "Worker, slot and service credentials must be distinct" });
  }
  if (config.workers.some((worker) => worker.slots.some((slot) => "runtime" in slot)) && (config.nativeGit === undefined || config.credentials.webhook === undefined)) {
    context.addIssue({ code: "custom", message: "CI slots require native Git execution authority" });
  }
  if (config.workers.some((worker) => worker.slots.some((slot) => "taskType" in slot)) && config.credentials.tasks === undefined) {
    context.addIssue({ code: "custom", message: "Task slots require a separate task issuer credential" });
  }
});
export type ExecutionServiceConfig = z.infer<typeof executionServiceConfigSchema>;
