import { z } from "zod";
import { executionConnectionSchema } from "@slop-lab/dim-contracts-execution/connections";
export const ciQueryConnectionSchema = executionConnectionSchema.extend({ role: z.literal("query") });
export type CiQueryConnection = z.infer<typeof ciQueryConnectionSchema>;
