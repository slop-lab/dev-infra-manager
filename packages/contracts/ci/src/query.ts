import { z } from "zod";
import { executionEventSchema } from "./execution-protocol.js";
import { executionSchema, executionResultSchema, type Execution } from "./aggregate.js";

const event = executionEventSchema.unwrap().shape;
const state = executionSchema.shape;
export const executionSummarySchema = z.object({ id: state.id, eventId: event.eventId, projectId: event.projectId, repositoryId: event.repositoryId,
  jobName: event.jobName, executionKind: event.executionKind, phase: state.phase, generationId: state.generationId,
  createdAt: state.createdAt, retryOf: state.retryOf, cancelRequestedAt: state.cancelRequestedAt, workerId: state.workerId, slotId: state.slotId, publication: state.publication,
  outcome: executionResultSchema.shape.result.optional(), completion: executionResultSchema.shape.completion.optional(),
  finishedAt: executionResultSchema.shape.finishedAt.optional()
}).strict();
export type ExecutionSummary = z.infer<typeof executionSummarySchema>;
export const executionDetailSchema = z.object({ job: executionSummarySchema, result: executionResultSchema.optional() }).strict();

/** This projection contains no worker lease, execution grant, script or raw diagnostics. */
export function executionSummary(job: Pick<Execution, "id" | "event" | "phase" | "generationId" | "createdAt" | "workerId" | "slotId" | "publication" | "retryOf" | "cancelRequestedAt">
  & { result?: Pick<NonNullable<Execution["result"]>, "result" | "completion" | "finishedAt"> | undefined }): ExecutionSummary {
  return executionSummarySchema.parse({ id: job.id, eventId: job.event.eventId, projectId: job.event.projectId, repositoryId: job.event.repositoryId,
    jobName: job.event.jobName, executionKind: job.event.executionKind, phase: job.phase, generationId: job.generationId,
    createdAt: job.createdAt, ...(job.retryOf === undefined ? {} : { retryOf: job.retryOf }),
    ...(job.cancelRequestedAt === undefined ? {} : { cancelRequestedAt: job.cancelRequestedAt }), ...(job.workerId === undefined ? {} : { workerId: job.workerId }),
    ...(job.slotId === undefined ? {} : { slotId: job.slotId }), publication: job.publication,
    ...(job.result === undefined ? {} : { outcome: job.result.result, completion: job.result.completion, finishedAt: job.result.finishedAt }) });
}

const { logs: _logs, ...metadata } = executionResultSchema.shape;
export const executionSummaryRowSchema = z.object({ ...executionSchema.shape,
  grant: z.undefined().optional(), leaseToken: z.undefined().optional(), profile: z.undefined().optional(), result: z.object(metadata).strict().optional()
}).strict();
