import { z } from "zod";
import { executionCredentialSchema } from "./execution-protocol.js";
export const ciQueryConnectionSchema = z.object({ schemaVersion: z.literal(1), role: z.literal("query"),
  endpoint: z.string().refine((value) => { try { const url = new URL(value); return url.origin === value
    && !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)); } catch { return false; } }),
  generationId: z.string().regex(/^[0-9a-f]{64}$/), credential: executionCredentialSchema
}).strict();
export type CiQueryConnection = z.infer<typeof ciQueryConnectionSchema>;


export const ciOperatorConnectionSchema = ciQueryConnectionSchema.extend({ role: z.literal("operator") });
