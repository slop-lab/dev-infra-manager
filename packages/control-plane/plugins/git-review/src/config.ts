import { z } from "zod";
const identity = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
export const codeReviewConfigSchema = z.object({ humanReviewers: z.array(z.object({ reviewerId: identity,
  username: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/),
  password: z.string().refine((value) => Buffer.from(value, "base64url").length === 32 && Buffer.from(value, "base64url").toString("base64url") === value)
}).strict().readonly()).readonly() }).strict().readonly();
export type CodeReviewConfig = z.infer<typeof codeReviewConfigSchema>;
export function parseCodeReviewConfig(value: unknown): CodeReviewConfig {
  const config = codeReviewConfigSchema.parse(value);
  const values = config.humanReviewers.flatMap((entry) => [entry.username, entry.password]);
  if (new Set(values).size !== values.length || new Set(config.humanReviewers.map((entry) => entry.reviewerId)).size !== config.humanReviewers.length) throw new Error("code review credentials and identities must be distinct");
  return config;
}
