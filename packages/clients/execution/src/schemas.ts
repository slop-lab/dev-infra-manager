import { z } from "zod";
import { executionSummarySchema } from "@slop-lab/dim-contracts-ci/query";
import { executionWorkersSchemaFor, taskSummarySchema } from "@slop-lab/dim-contracts-execution/query";

/** The deployment supports CI jobs and general plugin tasks on the same worker pool. */
export const scheduledSummarySchema = z.union([executionSummarySchema, taskSummarySchema]);
export const executionWorkersSchema = executionWorkersSchemaFor(scheduledSummarySchema);
