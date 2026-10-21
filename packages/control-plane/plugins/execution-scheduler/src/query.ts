import { z } from "zod";
import { executionSummarySchema } from "@slop-lab/dim-contracts-ci/query";
import { taskSummarySchema } from "@slop-lab/dim-contracts-execution/query";

/** The deployment supports CI jobs and general plugin tasks on the same worker pool. */
export const scheduledSummarySchema = z.union([executionSummarySchema, taskSummarySchema]);
export const executionWorkersSchema = z.array(z.object({ id: z.string(), slots: z.array(z.object({ id: z.string(),
  executionKind: z.union([z.enum(["ordinary-sysbox", "qemu"]), z.string().regex(/^task\//)]), state: z.enum(["idle", "busy", "cleanup-required"]),
  job: scheduledSummarySchema.optional(), leaseExpiresAt: z.number().int().optional()
}).strict()) }).strict()).max(256);
