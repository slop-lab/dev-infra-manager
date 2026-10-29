import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);

export const workflowJobSchema = z.object({
  name: identifier,
  provider: identifier,
  script: z.string().refine(isCandidatePath),
  repositories: z.array(identifier).max(64).optional().readonly(),
  argv: z.array(z.string()).refine(isCandidateArgv).readonly(),
}).strict().readonly();

export type WorkflowJob = z.infer<typeof workflowJobSchema>;

export function isCandidatePath(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !value.startsWith("/")
    && !/[\\\x00-\x1f\x7f]/.test(value)
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && part !== ".git");
}

export function isCandidateArgv(value: readonly string[]): boolean {
  const executable = value[0];
  return executable !== undefined && value.length <= 64 && executable.startsWith("/")
    && value.every((argument) => argument.length <= 16384 && !argument.includes("\0"));
}

export interface WorkflowCompiler {
  readonly configurationPath: string;
  readonly revision?: string;
  compile(bytes: Buffer): readonly WorkflowJob[];
}

export type CandidateRequiredCheck = Pick<WorkflowJob, "name" | "provider">;
