import { z } from "zod";
export const taskSummarySchema = z.object({ id: z.string().uuid(), taskType: z.string(), executionKind: z.string().regex(/^task\//),
  phase: z.enum(["queued", "assigned", "running", "recovering", "finished"]), generationId: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number().int().nonnegative(), publication: z.enum(["pending", "accepted", "stale"]) }).strict();

/** Worker capacity projection parameterized by the deployment's scheduled summary. */
export function executionWorkersSchemaFor<T extends z.ZodType>(summary: T) {
  return z.array(z.object({ id: z.string(), observedConnected: z.boolean(), lastSeenAt: z.number().int().nonnegative().optional(), slots: z.array(z.object({ id: z.string(),
    executionKind: z.union([z.enum(["ordinary-sysbox", "qemu"]), z.string().regex(/^task\//)]),
    state: z.enum(["idle", "busy", "cleanup-required"]), available: z.boolean(), job: summary.optional(), leaseExpiresAt: z.number().int().optional()
  }).strict()) }).strict()).max(256);
}
