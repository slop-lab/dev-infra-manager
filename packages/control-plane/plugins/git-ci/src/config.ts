import { z } from "zod";
import { executionCredentialSchema } from "@slop-lab/dim-contracts-execution/config";
import { executionSourceCredentialsSchema } from "@slop-lab/dim-contracts-ci/execution";
export const gitCiConfigSchema = executionSourceCredentialsSchema.extend({
  webhook: executionCredentialSchema.unwrap().extend({ endpoint: z.string().url().refine((input) => {
    const url = new URL(input); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }) }).strict().readonly(),
  compiler: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).default("dim")
}).strict().readonly().superRefine((config, context) => {
  const roles = [config.grantIssuer, config.candidateReader, config.resultReporter, config.webhook];
  if (new Set(roles.map(({ username }) => username)).size !== roles.length || new Set(roles.map(({ password }) => password)).size !== roles.length) {
    context.addIssue({ code: "custom", message: "Git CI roles must use distinct principals and secrets" });
  }
});
export type GitCiConfig = z.infer<typeof gitCiConfigSchema>;
