import { z } from "zod";
import { executionTaskSlotSchema, executionWorkerBaseConfigSchema } from "@slop-lab/dim-contracts-execution/config";
import { ciWorkerConfigFields, ciWorkerSlotSchema } from "@slop-lab/dim-contracts-ci/worker";

/** This worker provides both generic task handlers and isolated CI executors. */
export const executionWorkerConfigSchema = executionWorkerBaseConfigSchema.extend({
  ...ciWorkerConfigFields,
  slots: z.array(z.union([ciWorkerSlotSchema, executionTaskSlotSchema])).min(1).readonly()
}).strict().readonly()
  .refine((config) => new Set(config.slots.map((slot) => slot.id)).size === config.slots.length, "worker slot IDs must be unique")
  .refine((config) => !config.slots.some((slot) => "runtime" in slot) || (config.gitExecutable !== undefined && config.nativeGitEndpoint !== undefined), "CI slots require Git executable and native Git endpoint");
