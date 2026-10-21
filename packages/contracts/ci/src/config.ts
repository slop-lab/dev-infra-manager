import { z } from "zod";
import { executionIdentifierSchema, executionCredentialSchema } from "@slop-lab/dim-contracts-execution/config";
import { executionSourceCredentialsSchema, executionProfileSchema } from "./execution-protocol.js";

export const ciExecutionSourceSchema = executionSourceCredentialsSchema.extend({ endpoint: z.string().refine((value) => {
  try { const url = new URL(value); return url.origin === value && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}) }).strict().readonly();
export const ciExecutionCredentialsSchema = z.object({ webhook: executionCredentialSchema.optional(), query: executionCredentialSchema.optional() }).strict();
export const ciServiceSlotSchema = z.object({ id: executionIdentifierSchema, runtime: z.enum(["container", "vm"]), profile: executionProfileSchema }).strict().readonly();
