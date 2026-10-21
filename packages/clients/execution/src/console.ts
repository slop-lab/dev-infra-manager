import { z } from "zod";
import type { Operation } from "@slop-lab/dim-contracts-operations";
import { executionSummarySchema, executionDetailSchema } from "@slop-lab/dim-contracts-ci/query";
import { createCiQueryClient } from "./query.js";
import { createExecutionOperatorClient } from "./operator.js";
import { executionWorkersSchema, scheduledSummarySchema } from "./schemas.js";
const empty = z.object({}).strict().default({});
const job = z.object({ id: z.string().uuid() }).strict();
const retry = job.extend({ requestId: z.string().uuid() });
export const executionOperations: readonly Operation[] = [
  { name: "jobs.list", description: "List recent CI jobs", access: "read", parseInput: (v) => empty.parse(v), parseOutput: (v) => z.array(executionSummarySchema).max(100).parse(v) },
  { name: "jobs.detail", description: "Read job results and bounded logs", access: "read", parseInput: (v) => job.parse(v), parseOutput: (v) => executionDetailSchema.parse(v) },
  { name: "workers.list", description: "Read execution worker capacity", access: "operator", parseInput: (v) => empty.parse(v), parseOutput: (v) => executionWorkersSchema.parse(v) },
  { name: "jobs.cancel", description: "Cancel a queued or running execution", access: "operator", parseInput: (v) => job.parse(v), parseOutput: (v) => scheduledSummarySchema.parse(v) },
  { name: "jobs.retry", description: "Retry a finished execution", access: "operator", parseInput: (v) => retry.parse(v), parseOutput: (v) => scheduledSummarySchema.parse(v) }
];
/** Shared presentation operations; private connections remain in the calling trusted adapter. */
export async function createExecutionConsole(config: { queryConnection: string; operatorConnection?: string }) {
  const query = await createCiQueryClient(config.queryConnection);
  const operator = config.operatorConnection ? await createExecutionOperatorClient(config.operatorConnection) : undefined;
  const operations = operator ? executionOperations : executionOperations.filter((operation) => operation.access === "read");
  return { operations, async invoke(name: string, input: unknown): Promise<unknown> {
    const operation = operations.find((candidate) => candidate.name === name);
    if (!operation) throw new Error("Unknown or unavailable execution operation");
    const parsed = operation.parseInput(input);
    let result: unknown;
    if (name === "jobs.list") result = await query.jobs();
    else if (name === "jobs.detail") result = await query.detail(job.parse(parsed).id);
    else if (name === "workers.list") result = await operator!.workers();
    else if (name === "jobs.cancel") result = await operator!.cancel(job.parse(parsed).id);
    else { const value = retry.parse(parsed); result = await operator!.retry(value.id, value.requestId); }
    return operation.parseOutput(result);
  } };
}
