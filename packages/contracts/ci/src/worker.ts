import { isAbsolute } from "node:path";
import { z } from "zod";
import { executionIdentifierSchema, executionEndpointSchema, executionTaskSlotSchema, executionWorkerBaseConfigSchema } from "@slop-lab/dim-contracts-execution/config";
import { ciServiceSlotSchema } from "./config.js";

export const ciWorkerSlotSchema = z.object({ id: executionIdentifierSchema, runtime: z.enum(["container", "vm"]) }).strict().readonly();
export const ciWorkerConfigFields = { gitExecutable: z.string().refine(isAbsolute).optional(), nativeGitEndpoint: executionEndpointSchema.optional() };

/** Host configuration for the deployed service's common CI and plugin-task worker. */
export const executionWorkerConfigSchema = executionWorkerBaseConfigSchema.extend({
  ...ciWorkerConfigFields,
  slots: z.array(z.union([ciWorkerSlotSchema, executionTaskSlotSchema])).min(1).readonly()
}).strict().readonly()
  .refine((config) => new Set(config.slots.map((slot) => slot.id)).size === config.slots.length, "worker slot IDs must be unique")
  .refine((config) => !config.slots.some((slot) => "runtime" in slot) || (config.gitExecutable !== undefined && config.nativeGitEndpoint !== undefined), "CI slots require Git executable and native Git endpoint");

const executionWorkerEnrollmentBaseSchema = z.object({ schemaVersion: z.literal(1), workerId: executionIdentifierSchema,
  slots: z.array(z.union([ciServiceSlotSchema, executionTaskSlotSchema])).min(1).readonly()
}).strict();
export const executionWorkerEnrollmentSchema = executionWorkerEnrollmentBaseSchema.readonly()
  .refine((registration) => new Set(registration.slots.map((slot) => slot.id)).size === registration.slots.length, "worker slot IDs must be unique");

export const executionWorkerEnrollmentSecretSchema = executionWorkerEnrollmentBaseSchema.extend({
  generationId: executionWorkerBaseConfigSchema.shape.generationId,
  token: executionWorkerBaseConfigSchema.shape.token
}).strict().readonly()
  .refine((registration) => new Set(registration.slots.map((slot) => slot.id)).size === registration.slots.length, "worker slot IDs must be unique");

export const executionWorkerCapacitySpecSchema = executionWorkerEnrollmentBaseSchema.extend({
  stateDirectory: executionWorkerBaseConfigSchema.shape.stateDirectory,
  ...ciWorkerConfigFields
}).strict().readonly()
  .refine((config) => new Set(config.slots.map((slot) => slot.id)).size === config.slots.length, "worker slot IDs must be unique")
  .refine((config) => !config.slots.some((slot) => "runtime" in slot) || (config.gitExecutable !== undefined && config.nativeGitEndpoint !== undefined), "CI slots require Git executable and native Git endpoint");
