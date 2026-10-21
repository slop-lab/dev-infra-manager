import { z } from "zod";
export const taskSummarySchema = z.object({ id: z.string().uuid(), taskType: z.string(), executionKind: z.string().regex(/^task\//),
  phase: z.enum(["queued", "assigned", "running", "recovering", "finished"]), generationId: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number().int().nonnegative(), publication: z.enum(["pending", "accepted", "stale"]) }).strict();
