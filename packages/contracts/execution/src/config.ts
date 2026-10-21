import { isAbsolute } from "node:path";
import { z } from "zod";

export const executionIdentifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
export const executionCredentialSchema = z.object({ username: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  password: z.string().regex(/^[A-Za-z0-9_-]{43,}$/).refine((value) => Buffer.from(value, "base64url").toString("base64url") === value)
}).strict().readonly();
export const executionEndpointSchema = z.string().refine((value) => {
  try { const url = new URL(value); return url.origin === value && !url.username && !url.password
    && (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)); } catch { return false; }
});
export const executionTaskSlotSchema = z.object({ id: executionIdentifierSchema,
  taskType: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), handlerRevision: z.string().regex(/^[0-9a-f]{64}$/)
}).strict().readonly();
export const executionWorkerRegistrationBaseSchema = z.object({ id: executionIdentifierSchema,
  token: executionCredentialSchema.unwrap().shape.password }).strict();
export const executionServiceBaseConfigSchema = z.object({ schemaVersion: z.literal(1),
  claimLeaseMilliseconds: z.number().int().min(1_000).max(3_600_000),
  credentials: z.object({ operator: executionCredentialSchema, tasks: executionCredentialSchema.optional() }).strict(),
  workers: z.array(executionWorkerRegistrationBaseSchema.extend({ slots: z.array(executionTaskSlotSchema).min(1).readonly() })).readonly()
}).strict();
export const executionWorkerBaseConfigSchema = z.object({ schemaVersion: z.literal(1), workerId: executionIdentifierSchema,
  generationId: z.string().regex(/^[0-9a-f]{64}$/), stateDirectory: z.string().refine(isAbsolute), endpoint: executionEndpointSchema,
  token: z.string().regex(/^[A-Za-z0-9_-]{43,}$/), slots: z.array(executionTaskSlotSchema).min(1).readonly()
}).strict();
