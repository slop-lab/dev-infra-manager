import { isAbsolute } from "node:path";
import { z } from "zod";
import { executionIdentifierSchema, executionEndpointSchema } from "@slop-lab/dim-contracts-execution/config";

export const ciWorkerSlotSchema = z.object({ id: executionIdentifierSchema, runtime: z.enum(["container", "vm"]) }).strict().readonly();
export const ciWorkerConfigFields = { gitExecutable: z.string().refine(isAbsolute).optional(), nativeGitEndpoint: executionEndpointSchema.optional() };
