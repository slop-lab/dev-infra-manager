import { z } from "zod";
import { executionCredentialSchema, executionSourceCredentialsSchema, executionProfileSchema } from "./execution-protocol.js";
export const executionServiceConfigSchema = z.object({ schemaVersion: z.literal(1),
  claimLeaseMilliseconds: z.number().int().min(1_000).max(3_600_000),
  nativeGit: executionSourceCredentialsSchema.extend({ endpoint: z.string().refine((value) => { try { const url = new URL(value); return url.origin === value && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }) }).strict().readonly(),
  credentials: z.object({ webhook: executionCredentialSchema, query: executionCredentialSchema, operator: executionCredentialSchema }).strict().readonly(),
  workers: z.array(z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    token: executionCredentialSchema.unwrap().shape.password,
    slots: z.array(z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
      runtime: z.enum(["container", "vm"]), profile: executionProfileSchema }).strict().readonly()).min(1).readonly()
  }).strict().readonly()).readonly()
}).strict().readonly().superRefine((config, context) => {
  const roles = [...Object.values(config.credentials), ...Object.entries(config.nativeGit)
    .filter(([key]) => key !== "endpoint").map(([, value]) => value as z.infer<typeof executionCredentialSchema>),
    ...config.workers.map((worker) => ({ username: worker.id, password: worker.token }))];
  const values = roles.flatMap((role) => [role.username, role.password]);
  if (new Set(values).size !== values.length || config.workers.some((worker) =>
    new Set(worker.slots.map((slot) => slot.id)).size !== worker.slots.length)) {
    context.addIssue({ code: "custom", message: "CI worker, slot and service credentials must be distinct" });
  }
});
export type ExecutionServiceConfig = z.infer<typeof executionServiceConfigSchema>;

