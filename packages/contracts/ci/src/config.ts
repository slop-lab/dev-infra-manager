import { z } from "zod";
import { executionCredentialSchema, executionSourceCredentialsSchema, executionProfileSchema } from "./execution-protocol.js";
const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const taskSlot = z.object({ id: identifier, taskType: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), handlerRevision: z.string().regex(/^[0-9a-f]{64}$/) }).strict().readonly();
export const executionServiceConfigSchema = z.object({ schemaVersion: z.literal(1),
  claimLeaseMilliseconds: z.number().int().min(1_000).max(3_600_000),
  nativeGit: executionSourceCredentialsSchema.extend({ endpoint: z.string().refine((value) => { try { const url = new URL(value); return url.origin === value && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }) }).strict().readonly().optional(),
  credentials: z.object({ webhook: executionCredentialSchema, query: executionCredentialSchema, operator: executionCredentialSchema,
    tasks: executionCredentialSchema.optional() }).strict().readonly(),
  workers: z.array(z.object({ id: identifier, token: executionCredentialSchema.unwrap().shape.password,
    slots: z.array(z.union([z.object({ id: identifier, runtime: z.enum(["container", "vm"]), profile: executionProfileSchema }).strict().readonly(), taskSlot])).min(1).readonly()
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
  if (config.workers.some((worker) => worker.slots.some((slot) => "runtime" in slot)) && config.nativeGit === undefined) {
    context.addIssue({ code: "custom", message: "CI slots require native Git execution authority" });
  }
  if (config.workers.some((worker) => worker.slots.some((slot) => "taskType" in slot)) && config.credentials.tasks === undefined) {
    context.addIssue({ code: "custom", message: "Task slots require a separate task issuer credential" });
  }
});
export type ExecutionServiceConfig = z.infer<typeof executionServiceConfigSchema>;
