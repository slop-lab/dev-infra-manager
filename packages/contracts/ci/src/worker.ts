import { isAbsolute } from "node:path";
import { z } from "zod";
import { executionIdentifierSchema, executionEndpointSchema, executionTaskSlotSchema, executionWorkerBaseConfigSchema } from "@slop-lab/dim-contracts-execution/config";

export const ciWorkerSlotSchema = z.object({ id: executionIdentifierSchema, runtime: z.enum(["container", "vm"]) }).strict().readonly();
export const ciWorkerConfigFields = { gitExecutable: z.string().refine(isAbsolute).optional(), nativeGitEndpoint: executionEndpointSchema.optional() };

/** Host configuration for the deployed service's common CI and plugin-task worker. */
export const executionWorkerConfigSchema = executionWorkerBaseConfigSchema.extend({
  ...ciWorkerConfigFields,
  slots: z.array(z.union([ciWorkerSlotSchema, executionTaskSlotSchema])).min(1).readonly()
}).strict().readonly()
  .refine((config) => new Set(config.slots.map((slot) => slot.id)).size === config.slots.length, "worker slot IDs must be unique")
  .refine((config) => !config.slots.some((slot) => "runtime" in slot) || (config.gitExecutable !== undefined && config.nativeGitEndpoint !== undefined), "CI slots require Git executable and native Git endpoint");
