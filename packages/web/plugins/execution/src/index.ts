import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WebPlugin } from "@slop-lab/dim-web/plugin-api";
import type { Operation } from "@slop-lab/dim-contracts-operations";
import { createCiQueryClient, createExecutionOperatorClient, executionWorkersSchema, scheduledSummarySchema } from "@slop-lab/dim-execution-client";
import { executionSummarySchema, executionDetailSchema } from "@slop-lab/dim-contracts-ci/query";

const privatePath = z.string().refine(isAbsolute, "connection path must be absolute");
const configSchema = z.object({ queryConnection: privatePath, operatorConnection: privatePath.optional() }).strict();
const empty = z.object({}).strict().default({});
const job = z.object({ id: z.string().uuid() }).strict();
export const operations: readonly Operation[] = [
  { name: "jobs.list", description: "List recent CI jobs", access: "read", parseInput: (v) => empty.parse(v), parseOutput: (v) => z.array(executionSummarySchema).max(100).parse(v) },
  { name: "jobs.detail", description: "Read job results and bounded logs", access: "read", parseInput: (v) => job.parse(v), parseOutput: (v) => executionDetailSchema.parse(v) },
  { name: "workers.list", description: "Read execution worker capacity", access: "operator", parseInput: (v) => empty.parse(v), parseOutput: (v) => executionWorkersSchema.parse(v) },
  { name: "jobs.cancel", description: "Cancel a queued or running execution", access: "operator", parseInput: (v) => job.parse(v), parseOutput: (v) => scheduledSummarySchema.parse(v) },
  { name: "jobs.retry", description: "Retry a finished execution", access: "operator", parseInput: (v) => job.extend({ requestId: z.string().uuid() }).parse(v), parseOutput: (v) => scheduledSummarySchema.parse(v) }
];
export const webPlugin: WebPlugin = {
  id: "execution", title: "Execution", description: "CI jobs, diagnostic logs and worker capacity", operations,
  assets: { "panel.js": new URL("./assets/panel.js", import.meta.url) }, browserEntry: "panel.js",
  async create(input) {
    const config = configSchema.parse(input);
    const query = await createCiQueryClient(config.queryConnection);
    const operator = config.operatorConnection ? await createExecutionOperatorClient(config.operatorConnection) : undefined;
    return {
      operations: operator ? operations : operations.filter((operation) => operation.access === "read"),
      async invoke(name, input) {
        if (name === "jobs.list") return query.jobs();
        if (name === "jobs.detail") return query.detail(job.parse(input).id);
        if (!operator) throw new Error("Execution operator connection is not configured");
        if (name === "workers.list") return operator.workers();
        if (name === "jobs.cancel") return operator.cancel(job.parse(input).id);
        if (name === "jobs.retry") {
          const parsed = job.extend({ requestId: z.string().uuid().default(randomUUID) }).parse(input);
          return operator.retry(parsed.id, parsed.requestId);
        }
        throw new Error("Unknown execution operation");
      }
    };
  }
};
