import { z } from "zod";
import { executionCredentialSchema, executionEndpointSchema } from "./config.js";
export const executionConnectionSchema = z.object({ schemaVersion: z.literal(1), endpoint: executionEndpointSchema,
  generationId: z.string().regex(/^[0-9a-f]{64}$/), credential: executionCredentialSchema }).strict();
export const executionOperatorConnectionSchema = executionConnectionSchema.extend({ role: z.literal("operator") });
export type ExecutionOperatorConnection = z.infer<typeof executionOperatorConnectionSchema>;
